package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.SubModuleRepository;
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
public class SubModuleUseCases {

  private final ProjectRepository projects;
  private final SubModuleRepository modules;
  private final MutationSupport support;

  /**
   * Only for {@link StepUseCases#applyModuleDefaults}, and deliberately the whole use case rather
   * than the repository: copying a checklist is a decision about what a default means, not a
   * write, and a second copy of that decision here is how the two would drift apart.
   */
  private final StepUseCases steps;

  public SubModuleUseCases(
      ProjectRepository projects,
      SubModuleRepository modules,
      MutationSupport support,
      StepUseCases steps) {
    this.projects = projects;
    this.modules = modules;
    this.support = support;
    this.steps = steps;
  }

  @Transactional
  public UUID create(Actor actor, String moduleName, String name, String owner) {
    actor.require(PermissionKey.MODULE_CREATE);
    UUID projectId = actor.projectId();

    if (modules.existsByIdentity(projectId, moduleName, name)) {
      throw ServiceException.conflict(
          "This project already tracks " + moduleName + " · " + name + ".");
    }

    Modules.SubModule module =
        new Modules.SubModule(
            UUID.randomUUID(), projectId, moduleName, name, null,
            owner == null || owner.isBlank() ? null : owner,
            null, null, null, Instant.now());

    modules.insert(module);
    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE", "module created", module.id(), null);

    // Whatever checklist the module carries as its template is copied onto the new sub-module
    // here. Bulk-apply covers the sub-modules that already exist; without this, one created
    // next month starts bare and depends on somebody remembering — and a default that has to be
    // remembered is not a default. Silent when the module has no template, which is the common
    // case and must not turn creating a sub-module into an error.
    steps.applyModuleDefaults(actor, module.id(), moduleName);

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
  public void setFields(Actor actor, UUID subModuleId, String owner, boolean ownerPresent,
      String fniTargetDate, boolean datePresent, String moduleName, boolean modulePresent) {

    UUID projectId = actor.projectId();
    Modules.SubModule module = requireSubModule(projectId, subModuleId);
    Modules.SubModule updated = module;

    if (modulePresent) {
      updated = withModule(actor, updated, moduleName);
      if (!updated.moduleName().equals(module.moduleName())) {
        support.record(
            actor, projectId, Audit.Scope.MODULE, "MODULE",
            "moved — " + module.moduleName() + " → " + updated.moduleName(), module.id(), null);
      }
    }

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

    if (ownerPresent || datePresent || modulePresent) {
      modules.update(updated);
      support.bump(projectId);
    }
  }

  /**
   * Refiles a sub-module under a different module.
   *
   * <p>Two things are checked, and both are the kind that only bite later. The module has to be
   * one the project actually configures — otherwise a typo silently creates a module nobody
   * meant, and it appears on the matrix as a heading with one row under it. And the identity
   * {@code (module, name)} has to stay unique, because two rows tracking the same thing on the
   * same module is precisely the confusion the matrix exists to remove.
   *
   * <p>Nothing about the cells moves. A sub-module carries its deliverable row with it: what was
   * loaded is a fact about the work, not about which heading it was filed under.
   */
  private Modules.SubModule withModule(Actor actor, Modules.SubModule module, String moduleName) {
    actor.require(PermissionKey.MODULE_EDIT);
    String next = moduleName == null ? "" : moduleName.trim();

    if (next.isEmpty()) {
      throw ServiceException.validation("A sub-module has to sit on a module.");
    }
    if (next.equals(module.moduleName())) {
      return module;
    }
    if (!projects.config(module.projectId()).moduleNames().contains(next)) {
      throw ServiceException.validation(
          next + " is not a module in this project. Add it on the Configure screen first.");
    }
    if (modules.existsByIdentity(module.projectId(), next, module.name())) {
      throw ServiceException.conflict(
          "This project already tracks " + next + " · " + module.name() + ".");
    }

    return new Modules.SubModule(
        module.id(), module.projectId(), next, module.name(), module.libraryEntryId(),
        module.owner(), module.fniTargetDate(), module.fniClosedAt(), module.fniClosedBy(),
        module.createdAt());
  }

  @Transactional
  public void delete(Actor actor, UUID subModuleId) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();
    Modules.SubModule module = requireSubModule(projectId, subModuleId);

    if (module.libraryEntryId() != null) {
      modules.adjustLibraryUsage(module.libraryEntryId(), -1);
    }
    modules.delete(subModuleId);

    // Sub-module-scoped, but with a null sub-module id: the one it refers to no longer exists,
    // a dangling reference in the feed would render as "unknown sub-module" forever.
    support.record(
        actor, projectId, Audit.Scope.PROJECT, "MODULE",
        "module deleted — " + module.label(), null, null);
    support.bump(projectId);
  }

  // --- Sub-activities ---------------------------------------------------------

  /**
   * Adds a sub-activity.
   *
   * <p>The first one is the interesting case: from that moment the sub-module's cells become a
   * roll-up, so its own stored row is deleted. Leaving it would give the sub-module two answers —
   * one derived and one stale — and the partial unique indexes permit both to exist.
   */
  @Transactional
  public UUID addSubActivity(Actor actor, UUID subModuleId, String name) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();
    Modules.SubModule module = requireSubModule(projectId, subModuleId);

    List<Modules.SubActivity> existing = modules.subActivities(subModuleId);
    if (existing.isEmpty()) {
      modules.deleteSubModuleOwnCells(subModuleId);
    }

    Modules.SubActivity subActivity =
        new Modules.SubActivity(UUID.randomUUID(), subModuleId, name, existing.size());
    modules.insertSubActivity(subActivity);

    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE",
        "subActivity added — " + name, module.id(), subActivity.id());
    support.bump(projectId);
    return subActivity.id();
  }

  @Transactional
  public void renameSubActivity(Actor actor, UUID subModuleId, UUID subActivityId, String name) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();
    requireSubModule(projectId, subModuleId);

    Modules.SubActivity subActivity =
        modules
            .subActivity(subModuleId, subActivityId)
            .orElseThrow(() -> ServiceException.notFound("That subActivity is not on this module."));

    modules.renameSubActivity(subActivityId, name);
    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE",
        "subActivity renamed — " + subActivity.name() + " → " + name, subModuleId, subActivityId);
    support.bump(projectId);
  }

  @Transactional
  public void deleteSubActivity(Actor actor, UUID subModuleId, UUID subActivityId) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();
    requireSubModule(projectId, subModuleId);

    Modules.SubActivity subActivity =
        modules
            .subActivity(subModuleId, subActivityId)
            .orElseThrow(() -> ServiceException.notFound("That subActivity is not on this module."));

    modules.deleteSubActivity(subActivityId);

    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE",
        "subActivity deleted — " + subActivity.name(), subModuleId, null);
    support.bump(projectId);
  }

  // --- Links -----------------------------------------------------------------

  @Transactional
  public UUID addLink(Actor actor, UUID subModuleId, String type, String label, String url) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();
    requireSubModule(projectId, subModuleId);

    Modules.Link link = new Modules.Link(UUID.randomUUID(), subModuleId, type, label, url);
    modules.insertLink(link);

    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE", "link added — " + label, subModuleId, null);
    support.bump(projectId);
    return link.id();
  }

  @Transactional
  public void updateLink(Actor actor, UUID linkId, String type, String label, String url) {
    actor.require(PermissionKey.MODULE_EDIT);
    Modules.Link link = requireLink(actor, linkId);

    modules.updateLink(
        new Modules.Link(
            link.id(), link.subModuleId(),
            type == null ? link.type() : type,
            label == null ? link.label() : label,
            url == null ? link.url() : url));

    support.record(
        actor, actor.projectId(), Audit.Scope.MODULE, "MODULE",
        "link updated — " + (label == null ? link.label() : label), link.subModuleId(), null);
    support.bump(actor.projectId());
  }

  @Transactional
  public void deleteLink(Actor actor, UUID linkId) {
    actor.require(PermissionKey.MODULE_EDIT);
    Modules.Link link = requireLink(actor, linkId);

    modules.deleteLink(linkId);
    support.record(
        actor, actor.projectId(), Audit.Scope.MODULE, "MODULE",
        "link removed — " + link.label(), link.subModuleId(), null);
    support.bump(actor.projectId());
  }

  // --- The library -----------------------------------------------------------

  /**
   * Clones a library entry into this project.
   *
   * <p>Copies, never links. Editing the sub-module afterwards must not alter the library, and a
   * library entry that changed under a project which had already shipped from it would be worse
   * than no library at all.
   */
  @Transactional
  public UUID cloneFromLibrary(Actor actor, UUID entryId) {
    actor.require(PermissionKey.MODULE_CLONE);
    UUID projectId = actor.projectId();

    Modules.LibraryEntry entry =
        modules
            .libraryEntry(actor.tenantId(), entryId)
            .orElseThrow(() -> ServiceException.notFound("That library entry does not exist."));

    if (modules.existsByIdentity(projectId, entry.moduleName(), entry.name())) {
      throw ServiceException.conflict(
          "This project already tracks " + entry.moduleName() + " · " + entry.name() + ".");
    }

    Modules.SubModule module =
        new Modules.SubModule(
            UUID.randomUUID(), projectId, entry.moduleName(), entry.name(), entry.id(),
            null, null, null, null, Instant.now());
    modules.insert(module);

    int order = 0;
    for (String name : entry.subActivityNames()) {
      modules.insertSubActivity(
          new Modules.SubActivity(UUID.randomUUID(), module.id(), name, order++));
    }

    modules.adjustLibraryUsage(entry.id(), 1);

    support.record(
        actor, projectId, Audit.Scope.MODULE, "MODULE",
        "cloned from library — " + entry.name() + " " + entry.version(), module.id(), null);
    support.bump(projectId);
    return module.id();
  }

  // ---------------------------------------------------------------------------

  private Modules.SubModule requireSubModule(UUID projectId, UUID subModuleId) {
    return modules
        .find(projectId, subModuleId)
        .orElseThrow(() -> ServiceException.notFound("That module is not in this project."));
  }

  /** Also proves the link belongs to a module of the actor's project, not merely that it exists. */
  private Modules.Link requireLink(Actor actor, UUID linkId) {
    Modules.Link link =
        modules.link(linkId).orElseThrow(() -> ServiceException.notFound("That link does not exist."));
    requireSubModule(actor.projectId(), link.subModuleId());
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

  private static Modules.SubModule withOwner(Modules.SubModule module, String owner) {
    return new Modules.SubModule(
        module.id(), module.projectId(), module.moduleName(), module.name(), module.libraryEntryId(),
        owner, module.fniTargetDate(), module.fniClosedAt(), module.fniClosedBy(),
        module.createdAt());
  }

  private static Modules.SubModule withTargetDate(Modules.SubModule module, LocalDate date) {
    return new Modules.SubModule(
        module.id(), module.projectId(), module.moduleName(), module.name(), module.libraryEntryId(),
        module.owner(), date, module.fniClosedAt(), module.fniClosedBy(), module.createdAt());
  }
}
