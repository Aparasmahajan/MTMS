package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.StepRepository;
import io.mtms.application.port.SubModuleRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.StepGate;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Steps;
import io.mtms.domain.model.Tenancy;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Steps: the library, the configurations built from it, and the ticking.
 *
 * <p>Three different authorisations are at work here and they are deliberately not the same one:
 *
 * <ul>
 *   <li><strong>Building</strong> the library and the configurations is {@code project.config} —
 *       the same permission that owns columns, stages and environments, because it is the same
 *       act: an admin deciding how this project works. No new permission key was introduced for
 *       it, and that is a decision rather than an oversight: a new key would be held by nobody
 *       until an administrator went and granted it to every role by hand, so the feature would
 *       ship switched off in the one deployment that already exists.
 *   <li><strong>Ticking</strong> is gated by the roles named on the step itself, not by a
 *       permission. "Only QA may say testing is done" is the admin's statement about who checks
 *       this particular thing, and it is stored on the step.
 *   <li><strong>Commenting</strong> is open to anyone who can see the project. The person who
 *       knows why a step is stuck is very often not the person allowed to tick it.
 * </ul>
 *
 * <p>A holder of {@code project.config} may tick anything, and the event says so — recorded as an
 * override, with who really did it. That is the difference between an audit trail and a
 * decoration, and it is why the override is a flag on the event rather than a quiet exception.
 */
@Service
public class StepUseCases {

  private final StepRepository steps;
  private final SubModuleRepository subModules;
  private final AccessRepository access;
  private final MutationSupport support;

  public StepUseCases(
      StepRepository steps,
      SubModuleRepository subModules,
      AccessRepository access,
      MutationSupport support) {
    this.steps = steps;
    this.subModules = subModules;
    this.access = access;
    this.support = support;
  }

  // ---------------------------------------------------------------------------
  // The library
  // ---------------------------------------------------------------------------

  @Transactional
  public UUID createDefinition(Actor actor, String name, String description, List<UUID> roleIds) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();

    String trimmed = requireText(name, "A step needs a name.", 160);
    Set<UUID> roles = validRoles(actor, roleIds);

    Steps.Definition definition =
        new Steps.Definition(
            UUID.randomUUID(),
            projectId,
            trimmed,
            description == null ? "" : description.trim(),
            roles,
            null,
            Instant.now());

    steps.insertDefinition(definition);
    support.recordProjectChange(actor, projectId, "STEPS", "step added to the library — " + trimmed);
    support.bump(projectId);
    return definition.id();
  }

  @Transactional
  public void updateDefinition(
      Actor actor, UUID definitionId, String name, String description, List<UUID> roleIds) {

    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();
    Steps.Definition definition = requireDefinition(projectId, definitionId);

    String nextName = name == null ? definition.name() : requireText(name, "A step needs a name.", 160);
    String nextDescription = description == null ? definition.description() : description.trim();
    steps.updateDefinition(definitionId, nextName, nextDescription);

    if (roleIds != null) {
      // Never touches what has already been recorded. Narrowing who may tick a step in future is
      // not a claim that the ticks already made were wrong.
      steps.setDefinitionRoles(definitionId, validRoles(actor, roleIds));
    }

    support.recordProjectChange(actor, projectId, "STEPS", "step updated — " + nextName);
    support.bump(projectId);
  }

  /**
   * Retires a step.
   *
   * <p>Archived, never deleted. Retiring a step used by forty sub-modules must not destroy forty
   * histories and every comment written on them — so it leaves the screens and its record stays
   * exactly where it is, reachable from the change feed.
   */
  @Transactional
  public void archiveDefinition(Actor actor, UUID definitionId) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();
    Steps.Definition definition = requireDefinition(projectId, definitionId);

    steps.archiveDefinition(definitionId, Instant.now());
    support.recordProjectChange(
        actor,
        projectId,
        "STEPS",
        "step retired — " + definition.name() + ", keeping everything recorded against it");
    support.bump(projectId);
  }

  // ---------------------------------------------------------------------------
  // Configurations
  // ---------------------------------------------------------------------------

  /**
   * Attaches a named list of steps to one module, sub-module or sub-activity.
   *
   * @param definitionIds the steps, in the order they belong in <em>this</em> list. The order
   *     lives on the entries, so the same step can be first here and third somewhere else.
   */
  @Transactional
  public UUID createList(
      Actor actor,
      Steps.ScopeType scopeType,
      UUID scopeId,
      String name,
      boolean enforceOrder,
      List<UUID> definitionIds) {

    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();

    requireScope(projectId, scopeType, scopeId);
    String trimmed = requireText(name, "A configuration needs a name.", 160);

    Steps.StepList list =
        new Steps.StepList(
            UUID.randomUUID(), projectId, trimmed, scopeType, scopeId, enforceOrder, null,
            Instant.now());
    steps.insertList(list);

    int order = 0;
    for (UUID definitionId : definitionIds == null ? List.<UUID>of() : definitionIds) {
      Steps.Definition definition = requireDefinition(projectId, definitionId);
      steps.insertEntry(
          new Steps.Entry(UUID.randomUUID(), list.id(), definition.id(), order++));
    }

    support.record(
        actor,
        projectId,
        scopeType == Steps.ScopeType.MODULE ? Audit.Scope.PROJECT : Audit.Scope.MODULE,
        "STEPS",
        "checklist added — " + trimmed + ", " + order + (order == 1 ? " step" : " steps"),
        scopeType == Steps.ScopeType.SUB_MODULE ? scopeId : null,
        scopeType == Steps.ScopeType.SUB_ACTIVITY ? scopeId : null);
    support.bump(projectId);
    return list.id();
  }

  @Transactional
  public void updateList(Actor actor, UUID listId, String name, Boolean enforceOrder) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();
    Steps.StepList list = requireList(projectId, listId);

    String nextName =
        name == null ? list.name() : requireText(name, "A configuration needs a name.", 160);
    boolean nextOrder = enforceOrder == null ? list.enforceOrder() : enforceOrder;

    steps.updateList(listId, nextName, nextOrder);
    support.recordProjectChange(
        actor,
        projectId,
        "STEPS",
        "checklist updated — "
            + nextName
            + (nextOrder == list.enforceOrder()
                ? ""
                : nextOrder
                    ? ", now in a strict order"
                    : ", steps may now be done in any order"));
    support.bump(projectId);
  }

  @Transactional
  public void archiveList(Actor actor, UUID listId) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();
    Steps.StepList list = requireList(projectId, listId);

    steps.archiveList(listId, Instant.now());
    support.recordProjectChange(
        actor, projectId, "STEPS", "checklist removed — " + list.name() + ", keeping its history");
    support.bump(projectId);
  }

  /** Adds one step to the end of an existing list. */
  @Transactional
  public UUID addEntry(Actor actor, UUID listId, UUID definitionId) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();
    Steps.StepList list = requireList(projectId, listId);
    Steps.Definition definition = requireDefinition(projectId, definitionId);

    List<Steps.Entry> existing = steps.entriesOf(listId);
    if (existing.stream().anyMatch(entry -> entry.definitionId().equals(definitionId))) {
      throw ServiceException.conflict(definition.name() + " is already in " + list.name() + ".");
    }

    Steps.Entry entry =
        new Steps.Entry(UUID.randomUUID(), listId, definitionId, nextOrderIndex(existing));
    steps.insertEntry(entry);

    support.recordProjectChange(
        actor, projectId, "STEPS", "step added to " + list.name() + " — " + definition.name());
    support.bump(projectId);
    return entry.id();
  }

  /**
   * Takes one step out of one list.
   *
   * <p>Refused once anything has been recorded against it. This is the one delete in the whole
   * feature, and it deletes a <em>setting</em> — removing the entry takes its ticks, its history
   * and its comments with it by cascade. So it is allowed only while there is nothing to lose;
   * after that the honest action is to retire the step, which keeps everything.
   */
  @Transactional
  public void removeEntry(Actor actor, UUID entryId) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();

    Steps.Entry entry = requireEntry(projectId, entryId);
    Steps.StepList list = requireList(projectId, entry.stepListId());
    Steps.Definition definition = requireDefinition(projectId, entry.definitionId());

    Optional<Steps.Progress> progress = steps.progressOf(entryId);
    if (progress.isPresent() && progress.get().state() != Steps.State.TODO) {
      throw ServiceException.validation(
          definition.name()
              + " has been ticked or blocked on this checklist, and removing it would destroy that"
              + " record along with its comments. Retire the step in the library instead — it"
              + " leaves every screen and keeps its history.");
    }

    steps.deleteEntry(entryId);
    support.recordProjectChange(
        actor, projectId, "STEPS", "step removed from " + list.name() + " — " + definition.name());
    support.bump(projectId);
  }

  /** Reorders one list. The ids arrive in the order they should appear. */
  @Transactional
  public void reorder(Actor actor, UUID listId, List<UUID> entryIds) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();
    Steps.StepList list = requireList(projectId, listId);

    Set<UUID> known =
        steps.entriesOf(listId).stream().map(Steps.Entry::id).collect(java.util.stream.Collectors.toSet());
    List<UUID> ordered = entryIds == null ? List.of() : entryIds;
    if (!known.equals(new HashSet<>(ordered))) {
      // A partial order would silently leave the missing entries wherever they happened to be,
      // which looks like the reorder half-worked. Say so instead.
      throw ServiceException.validation(
          "A reorder has to list every step in the checklist exactly once.");
    }

    int index = 0;
    for (UUID entryId : ordered) {
      steps.setEntryOrder(entryId, index++);
    }

    support.recordProjectChange(actor, projectId, "STEPS", "checklist reordered — " + list.name());
    support.bump(projectId);
  }

  // ---------------------------------------------------------------------------
  // Ticking
  // ---------------------------------------------------------------------------

  /**
   * Moves one step to a new state.
   *
   * <p>The whole gate is here, in this order: the list's order first, then who is allowed, then
   * whether a block came with a reason. Each refusal names the thing standing in the way, because
   * "not allowed" sends somebody to ask an administrator about a permission when the real answer
   * is that step 1 is not done yet.
   *
   * @param reason required when blocking; also carried on an override, where it is the admin
   *     saying why they ticked on somebody else's behalf.
   */
  @Transactional
  public void setState(Actor actor, UUID entryId, Steps.State target, String reason) {
    UUID projectId = actor.projectId();
    actor.require(PermissionKey.PROJECT_VIEW);

    Steps.Entry entry = requireEntry(projectId, entryId);
    Steps.StepList list = requireList(projectId, entry.stepListId());
    Steps.Definition definition = requireDefinition(projectId, entry.definitionId());

    Steps.State current =
        steps.progressOf(entryId).map(Steps.Progress::state).orElse(Steps.State.TODO);
    if (current == target) {
      return;
    }

    if (StepGate.reasonRequired(target, reason)) {
      throw ServiceException.validation(
          "Blocking \""
              + definition.name()
              + "\" needs a reason in writing. \"Blocked\" on its own tells nobody what to do"
              + " about it.");
    }

    // Only ticking is ordered. Un-ticking and blocking are always allowed: a sequence is a claim
    // about the order work is done in, not a reason to stop somebody correcting the record.
    if (target == Steps.State.DONE) {
      Optional<String> blocker =
          StepGate.orderBlocker(steps.load(projectId).resolveOne(list), entryId);
      if (blocker.isPresent()) {
        throw ServiceException.validation(
            list.name()
                + " runs in a strict order, and \""
                + blocker.get()
                + "\" is not done yet.");
      }
    }

    List<String> allowedRoles = roleNames(actor.tenantId(), definition.roleIds());
    boolean override = false;

    if (!StepGate.mayTick(roleIdsOf(actor), definition)) {
      if (!actor.can(PermissionKey.PROJECT_CONFIG)) {
        throw new ServiceException(
            ServiceException.Code.FORBIDDEN, StepGate.deniedReason(definition, allowedRoles));
      }
      // An administrator may act when the right person is unavailable, and the record says that
      // is what happened rather than pretending the right person checked it.
      override = true;
    }

    Instant now = Instant.now();
    steps.upsertProgress(
        new Steps.Progress(
            entryId,
            target,
            target == Steps.State.BLOCKED ? reason.trim() : null,
            actor.userId(),
            now));

    steps.appendEvent(
        new Steps.Event(
            UUID.randomUUID(),
            entryId,
            current,
            target,
            override,
            reason == null || reason.isBlank() ? null : reason.trim(),
            actor.userId(),
            actor.who(),
            now));

    String onBehalf =
        override
            ? " (on behalf of "
                + String.join(
                    " or ", allowedRoles.isEmpty() ? List.of("a role that no longer exists") : allowedRoles)
                + ")"
            : "";

    Scope scope = scopeOf(projectId, list);
    support.record(
        actor,
        projectId,
        scope.auditScope(),
        "STEPS",
        definition.name()
            + " — "
            + StepGate.describe(current, target)
            + onBehalf
            + (target == Steps.State.BLOCKED ? " — " + reason.trim() : ""),
        scope.subModuleId(),
        scope.subActivityId());
    support.bump(projectId);
  }

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  /** Open to anyone who can see the project. Ticking is gated; talking about it is not. */
  @Transactional
  public UUID comment(Actor actor, UUID entryId, String body) {
    actor.require(PermissionKey.PROJECT_VIEW);
    UUID projectId = actor.projectId();

    Steps.Entry entry = requireEntry(projectId, entryId);
    requireList(projectId, entry.stepListId());
    String text = requireText(body, "A comment cannot be empty.", 4000);

    Steps.Comment comment =
        new Steps.Comment(
            UUID.randomUUID(), entryId, actor.userId(), actor.who(), text, Instant.now(), null, null);
    steps.insertComment(comment);
    support.bump(projectId);
    return comment.id();
  }

  /**
   * Hides a comment.
   *
   * <p>Its author, or an administrator. Archived rather than deleted, like everything else here —
   * and unlike everything else here, that matters mostly for the person who wrote it: a comment
   * that can be made to have never existed is a comment nobody writes candidly.
   */
  @Transactional
  public void archiveComment(Actor actor, UUID commentId) {
    UUID projectId = actor.projectId();
    Steps.Comment comment =
        steps
            .comment(commentId)
            .orElseThrow(() -> ServiceException.notFound("That comment does not exist."));

    Steps.Entry entry = requireEntry(projectId, comment.entryId());
    requireList(projectId, entry.stepListId());

    boolean mine = actor.userId().equals(comment.authorId());
    if (!mine && !actor.can(PermissionKey.PROJECT_CONFIG)) {
      throw new ServiceException(
          ServiceException.Code.FORBIDDEN, "Only the author or an admin can remove a comment.");
    }

    steps.archiveComment(commentId, Instant.now());
    support.bump(projectId);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Which sub-module and sub-activity, if any, a list's audit entry should point at. */
  private record Scope(Audit.Scope auditScope, UUID subModuleId, UUID subActivityId) {}

  private Scope scopeOf(UUID projectId, Steps.StepList list) {
    return switch (list.scopeType()) {
      case MODULE -> new Scope(Audit.Scope.PROJECT, null, null);
      case SUB_MODULE -> new Scope(Audit.Scope.MODULE, list.scopeId(), null);
      case SUB_ACTIVITY -> {
        // The feed is read per sub-module, so a sub-activity's entry has to carry its parent or
        // it would never appear on the screen the change was made from.
        UUID parent =
            subModules.findAll(projectId).stream()
                .filter(
                    subModule ->
                        subModules.subActivities(subModule.id()).stream()
                            .anyMatch(subActivity -> subActivity.id().equals(list.scopeId())))
                .map(Modules.SubModule::id)
                .findFirst()
                .orElse(null);
        yield new Scope(Audit.Scope.MODULE, parent, list.scopeId());
      }
    };
  }

  /**
   * The role ids this person actually holds in this organisation.
   *
   * <p>Read from the memberships rather than from {@code Actor.roleKeys}, because a step names
   * roles by id and matching on a key would break the moment two roles shared one — which is
   * exactly what an admin creating "QA" alongside a system "qa" would do.
   */
  private Set<UUID> roleIdsOf(Actor actor) {
    return access.membershipsOf(actor.userId()).stream()
        .filter(membership -> membership.tenantId().equals(actor.tenantId()))
        .filter(
            membership ->
                membership.projectId() == null || membership.projectId().equals(actor.projectId()))
        .map(Tenancy.Membership::roleId)
        .collect(java.util.stream.Collectors.toSet());
  }

  private List<String> roleNames(UUID tenantId, Set<UUID> roleIds) {
    return access.roles(tenantId).stream()
        .filter(role -> roleIds.contains(role.id()))
        .map(Tenancy.Role::name)
        .sorted()
        .toList();
  }

  /** Roles that exist in this organisation. An unknown id would gate a step to nobody. */
  private Set<UUID> validRoles(Actor actor, List<UUID> roleIds) {
    if (roleIds == null || roleIds.isEmpty()) {
      return Set.of();
    }
    Set<UUID> known =
        access.roles(actor.tenantId()).stream()
            .map(Tenancy.Role::id)
            .collect(java.util.stream.Collectors.toSet());

    List<UUID> unknown = roleIds.stream().filter(id -> !known.contains(id)).toList();
    if (!unknown.isEmpty()) {
      throw ServiceException.validation("That is not a role in this organisation.");
    }
    return Set.copyOf(new ArrayList<>(roleIds));
  }

  /**
   * Proves the thing a list is being attached to is in this project.
   *
   * <p><strong>Module scope is modelled but not yet reachable.</strong> The schema, the domain and
   * this repository all carry it, because the rule is "the lowest level that exists" and a module
   * with no sub-modules has to be able to hold its own checklist. What is missing is upstream: a
   * module reaches the API as a <em>name</em> in the project's configuration and has no id on the
   * wire, so there is nothing for a caller to attach a list to. Exposing module ids is its own
   * change — it touches the configuration shape, the Configure screen and the matrix — and
   * guessing one here would be worse than refusing. Refusing with the reason is what this does.
   */
  private void requireScope(UUID projectId, Steps.ScopeType scopeType, UUID scopeId) {
    switch (scopeType) {
      case SUB_MODULE -> subModules
          .find(projectId, scopeId)
          .orElseThrow(() -> ServiceException.notFound("That sub-module is not in this project."));
      case SUB_ACTIVITY -> {
        boolean found =
            subModules.findAll(projectId).stream()
                .anyMatch(
                    subModule ->
                        subModules.subActivities(subModule.id()).stream()
                            .anyMatch(subActivity -> subActivity.id().equals(scopeId)));
        if (!found) {
          throw ServiceException.notFound("That sub-activity is not in this project.");
        }
      }
      case MODULE ->
          throw ServiceException.validation(
              "A checklist attaches to a sub-module or a sub-activity. Module-level checklists"
                  + " are not available yet — a module has no id on the API, only a name.");
    }
  }

  private Steps.Definition requireDefinition(UUID projectId, UUID definitionId) {
    return steps
        .definition(projectId, definitionId)
        .orElseThrow(() -> ServiceException.notFound("That step is not in this project."));
  }

  private Steps.StepList requireList(UUID projectId, UUID listId) {
    return steps
        .list(projectId, listId)
        .orElseThrow(() -> ServiceException.notFound("That checklist is not in this project."));
  }

  /** Also proves the entry belongs to a list of this project, not merely that it exists. */
  private Steps.Entry requireEntry(UUID projectId, UUID entryId) {
    Steps.Entry entry =
        steps.entry(entryId).orElseThrow(() -> ServiceException.notFound("That step is not here."));
    requireList(projectId, entry.stepListId());
    return entry;
  }

  private static int nextOrderIndex(List<Steps.Entry> existing) {
    return existing.stream().mapToInt(Steps.Entry::orderIndex).max().orElse(-1) + 1;
  }

  private static String requireText(String value, String message, int max) {
    String trimmed = value == null ? "" : value.trim();
    if (trimmed.isEmpty()) {
      throw ServiceException.validation(message);
    }
    if (trimmed.length() > max) {
      throw ServiceException.validation(
          "That is longer than the " + max + " characters this field holds.");
    }
    return trimmed;
  }
}
