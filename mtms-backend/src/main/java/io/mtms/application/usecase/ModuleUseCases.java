package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.ModuleRepository;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Modules;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Creating, editing and structuring modules. */
@Service
public class ModuleUseCases {

  private final ProjectRepository projects;
  private final ModuleRepository modules;
  private final MutationSupport support;

  public ModuleUseCases(
      ProjectRepository projects, ModuleRepository modules, MutationSupport support) {
    this.projects = projects;
    this.modules = modules;
    this.support = support;
  }

  @Transactional
  public UUID create(Actor actor, String nodeType, String name, String owner) {
    actor.require(PermissionKey.MODULE_CREATE);
    UUID projectId = actor.projectId();

    if (modules.existsByIdentity(projectId, nodeType, name)) {
      throw ServiceException.conflict(
          "This project already tracks " + nodeType + " · " + name + ".");
    }

    Modules.Module module =
        new Modules.Module(
            UUID.randomUUID(), projectId, nodeType, name, null,
            owner == null || owner.isBlank() ? null : owner,
            null, null, null, Instant.now());

    modules.insert(module);
    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE", "module created", module.id(), null);
    support.bump(projectId);
    return module.id();
  }

  /**
   * Sets the owner and the FNI target date.
   *
   * <p>The two are permissioned separately — a release manager sets dates, a team lead assigns
   * owners — so each field is checked on its own rather than the method requiring both.
   */
  @Transactional
  public void setFields(Actor actor, UUID moduleId, String owner, boolean ownerPresent,
      String fniTargetDate, boolean datePresent) {

    UUID projectId = actor.projectId();
    Modules.Module module = requireModule(projectId, moduleId);
    Modules.Module updated = module;

    if (ownerPresent) {
      actor.require(PermissionKey.MODULE_EDIT);
      String before = module.owner() == null ? "unassigned" : module.owner();
      String next = owner == null || owner.isBlank() ? null : owner;
      updated = withOwner(updated, next);
      support.record(
          actor, projectId, Audit.Scope.MODULE, "MODULE",
          "owner " + before + " → " + (next == null ? "unassigned" : next), module.id(), null);
    }

    if (datePresent) {
      actor.require(PermissionKey.FNI_DATE);
      String before = module.fniTargetDate() == null ? "not set" : module.fniTargetDate().toString();
      LocalDate next = parseDate(fniTargetDate);
      updated = withTargetDate(updated, next);
      support.record(
          actor, projectId, Audit.Scope.MODULE, "MODULE",
          "FNI target date " + before + " → " + (next == null ? "not set" : next.toString()),
          module.id(), null);
    }

    if (ownerPresent || datePresent) {
      modules.update(updated);
      support.bump(projectId);
    }
  }

  @Transactional
  public void delete(Actor actor, UUID moduleId) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();
    Modules.Module module = requireModule(projectId, moduleId);

    if (module.libraryEntryId() != null) {
      modules.adjustLibraryUsage(module.libraryEntryId(), -1);
    }
    modules.delete(moduleId);

    // Module-scoped, but with a null module id: the module it refers to no longer exists, and
    // a dangling reference in the feed would render as "unknown module" forever.
    support.record(
        actor, projectId, Audit.Scope.PROJECT, "MODULE",
        "module deleted — " + module.label(), null, null);
    support.bump(projectId);
  }

  // --- Subactivities ---------------------------------------------------------

  /**
   * Adds a subactivity.
   *
   * <p>The first one is the interesting case: from that moment the module's cells become a
   * roll-up, so its own stored row is deleted. Leaving it would give the module two answers —
   * one derived and one stale — and the partial unique indexes permit both to exist.
   */
  @Transactional
  public UUID addSubactivity(Actor actor, UUID moduleId, String name) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();
    Modules.Module module = requireModule(projectId, moduleId);

    List<Modules.Subactivity> existing = modules.subactivities(moduleId);
    if (existing.isEmpty()) {
      modules.deleteModuleOwnCells(moduleId);
    }

    Modules.Subactivity subactivity =
        new Modules.Subactivity(UUID.randomUUID(), moduleId, name, existing.size());
    modules.insertSubactivity(subactivity);

    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE",
        "subactivity added — " + name, module.id(), subactivity.id());
    support.bump(projectId);
    return subactivity.id();
  }

  @Transactional
  public void renameSubactivity(Actor actor, UUID moduleId, UUID subactivityId, String name) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();
    requireModule(projectId, moduleId);

    Modules.Subactivity subactivity =
        modules
            .subactivity(moduleId, subactivityId)
            .orElseThrow(() -> ServiceException.notFound("That subactivity is not on this module."));

    modules.renameSubactivity(subactivityId, name);
    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE",
        "subactivity renamed — " + subactivity.name() + " → " + name, moduleId, subactivityId);
    support.bump(projectId);
  }

  @Transactional
  public void deleteSubactivity(Actor actor, UUID moduleId, UUID subactivityId) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();
    requireModule(projectId, moduleId);

    Modules.Subactivity subactivity =
        modules
            .subactivity(moduleId, subactivityId)
            .orElseThrow(() -> ServiceException.notFound("That subactivity is not on this module."));

    modules.deleteSubactivity(subactivityId);

    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE",
        "subactivity deleted — " + subactivity.name(), moduleId, null);
    support.bump(projectId);
  }

  // --- Links -----------------------------------------------------------------

  @Transactional
  public UUID addLink(Actor actor, UUID moduleId, String type, String label, String url) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();
    requireModule(projectId, moduleId);

    Modules.Link link = new Modules.Link(UUID.randomUUID(), moduleId, type, label, url);
    modules.insertLink(link);

    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE", "link added — " + label, moduleId, null);
    support.bump(projectId);
    return link.id();
  }

  @Transactional
  public void updateLink(Actor actor, UUID linkId, String type, String label, String url) {
    actor.require(PermissionKey.MODULE_EDIT);
    Modules.Link link = requireLink(actor, linkId);

    modules.updateLink(
        new Modules.Link(
            link.id(), link.moduleId(),
            type == null ? link.type() : type,
            label == null ? link.label() : label,
            url == null ? link.url() : url));

    support.record(
        actor, actor.projectId(), Audit.Scope.MODULE, "MODULE",
        "link updated — " + (label == null ? link.label() : label), link.moduleId(), null);
    support.bump(actor.projectId());
  }

  @Transactional
  public void deleteLink(Actor actor, UUID linkId) {
    actor.require(PermissionKey.MODULE_EDIT);
    Modules.Link link = requireLink(actor, linkId);

    modules.deleteLink(linkId);
    support.record(
        actor, actor.projectId(), Audit.Scope.MODULE, "MODULE",
        "link removed — " + link.label(), link.moduleId(), null);
    support.bump(actor.projectId());
  }

  // --- The library -----------------------------------------------------------

  /**
   * Clones a library entry into this project.
   *
   * <p>Copies, never links. Editing the module afterwards must not alter the library, and a
   * library entry that changed under a project which had already shipped from it would be worse
   * than no library at all.
   */
  @Transactional
  public UUID cloneFromLibrary(Actor actor, UUID entryId) {
    actor.require(PermissionKey.MODULE_CLONE);
    UUID projectId = actor.projectId();

    Modules.ModuleLibraryEntry entry =
        modules
            .libraryEntry(actor.tenantId(), entryId)
            .orElseThrow(() -> ServiceException.notFound("That library entry does not exist."));

    if (modules.existsByIdentity(projectId, entry.nodeType(), entry.name())) {
      throw ServiceException.conflict(
          "This project already tracks " + entry.nodeType() + " · " + entry.name() + ".");
    }

    Modules.Module module =
        new Modules.Module(
            UUID.randomUUID(), projectId, entry.nodeType(), entry.name(), entry.id(),
            null, null, null, null, Instant.now());
    modules.insert(module);

    int order = 0;
    for (String name : entry.subactivityNames()) {
      modules.insertSubactivity(
          new Modules.Subactivity(UUID.randomUUID(), module.id(), name, order++));
    }

    modules.adjustLibraryUsage(entry.id(), 1);

    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE",
        "cloned from library — " + entry.name() + " " + entry.version(), module.id(), null);
    support.bump(projectId);
    return module.id();
  }

  // ---------------------------------------------------------------------------

  private Modules.Module requireModule(UUID projectId, UUID moduleId) {
    return modules
        .find(projectId, moduleId)
        .orElseThrow(() -> ServiceException.notFound("That module is not in this project."));
  }

  /** Also proves the link belongs to a module of the actor's project, not merely that it exists. */
  private Modules.Link requireLink(Actor actor, UUID linkId) {
    Modules.Link link =
        modules.link(linkId).orElseThrow(() -> ServiceException.notFound("That link does not exist."));
    requireModule(actor.projectId(), link.moduleId());
    return link;
  }

  private static LocalDate parseDate(String value) {
    if (value == null || value.isBlank()) {
      return null;
    }
    try {
      return LocalDate.parse(value);
    } catch (DateTimeParseException e) {
      throw ServiceException.validation("Expected a date as YYYY-MM-DD.");
    }
  }

  private static Modules.Module withOwner(Modules.Module module, String owner) {
    return new Modules.Module(
        module.id(), module.projectId(), module.nodeType(), module.name(), module.libraryEntryId(),
        owner, module.fniTargetDate(), module.fniClosedAt(), module.fniClosedBy(),
        module.createdAt());
  }

  private static Modules.Module withTargetDate(Modules.Module module, LocalDate date) {
    return new Modules.Module(
        module.id(), module.projectId(), module.nodeType(), module.name(), module.libraryEntryId(),
        module.owner(), date, module.fniClosedAt(), module.fniClosedBy(), module.createdAt());
  }
}
