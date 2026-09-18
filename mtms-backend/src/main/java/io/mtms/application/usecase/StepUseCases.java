package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.OwnerRepository;
import io.mtms.application.port.ProjectRepository;
import io.mtms.application.port.StepData;
import io.mtms.application.port.StepRepository;
import io.mtms.application.port.SubModuleRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.StepGate;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Notifications;
import io.mtms.domain.model.Owners;
import io.mtms.domain.model.Scope;
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
  private final ProjectRepository projects;
  private final SubModuleRepository subModules;
  private final AccessRepository access;
  private final OwnerRepository owners;
  private final NotificationUseCases notifications;
  private final MutationSupport support;

  public StepUseCases(
      StepRepository steps,
      ProjectRepository projects,
      SubModuleRepository subModules,
      AccessRepository access,
      OwnerRepository owners,
      NotificationUseCases notifications,
      MutationSupport support) {
    this.steps = steps;
    this.projects = projects;
    this.subModules = subModules;
    this.access = access;
    this.owners = owners;
    this.notifications = notifications;
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
      Scope scopeType,
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
        scopeType == Scope.MODULE ? Audit.Scope.PROJECT : Audit.Scope.MODULE,
        "STEPS",
        "checklist added — " + trimmed + ", " + order + (order == 1 ? " step" : " steps"),
        scopeType == Scope.SUB_MODULE ? scopeId : null,
        scopeType == Scope.SUB_ACTIVITY ? scopeId : null);
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

  /**
   * Copies one checklist onto every sub-module of a module.
   *
   * <p>Without this the feature does not survive contact with a real project. CR_AUTOMATION has
   * eighteen sub-modules today and the real number is in the hundreds; nobody is going to attach
   * a checklist to two hundred things one at a time, so a checklist gets built on a handful of
   * rows as a demonstration and then abandoned.
   *
   * <p>Three decisions, and the second is the one that could have gone badly:
   *
   * <ul>
   *   <li><strong>It copies, it does not link.</strong> Each sub-module gets its own list and its
   *       own entries, so ticking one does not tick forty and an admin can edit one afterwards
   *       without touching the rest. The same choice the module library already makes.
   *   <li><strong>It adds alongside, it never replaces.</strong> A sub-module that already has a
   *       checklist keeps it. A bulk action that silently overwrote somebody's bespoke list is
   *       the kind of thing that gets a tool banned, and the model allows several lists on one
   *       thing precisely so this does not have to choose.
   *   <li><strong>Sub-modules that already have a list by this name are skipped</strong>, not
   *       duplicated — so running it twice after adding a sub-module does the obvious thing
   *       instead of leaving half the project with two copies.
   * </ul>
   *
   * @return how many sub-modules it landed on. The caller reports it, because "applied to 0"
   *     and "applied to 40" look identical otherwise.
   */
  @Transactional
  public int applyToModule(Actor actor, UUID listId, String moduleName) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();

    Steps.StepList source = requireList(projectId, listId);
    Steps.ResolvedList resolved = steps.load(projectId).resolveOne(source);

    if (resolved.entries().isEmpty()) {
      throw ServiceException.validation(
          "\"" + source.name() + "\" has no steps on it yet, so there is nothing to apply.");
    }

    List<Modules.SubModule> targets =
        subModules.findAll(projectId).stream()
            .filter(subModule -> subModule.moduleName().equals(moduleName))
            .filter(subModule -> !subModule.id().equals(source.scopeId()))
            .toList();

    if (targets.isEmpty()) {
      throw ServiceException.validation(
          "There are no other sub-modules on " + moduleName + " to apply it to.");
    }

    int applied = 0;
    for (Modules.SubModule target : targets) {
      boolean already =
          steps.listsFor(projectId, Scope.SUB_MODULE, target.id()).stream()
              .anyMatch(list -> !list.isArchived() && list.name().equals(source.name()));
      if (already) {
        continue;
      }

      Steps.StepList copy =
          new Steps.StepList(
              UUID.randomUUID(),
              projectId,
              source.name(),
              Scope.SUB_MODULE,
              target.id(),
              source.enforceOrder(),
              null,
              Instant.now());
      steps.insertList(copy);

      int order = 0;
      for (Steps.ResolvedEntry entry : resolved.entries()) {
        steps.insertEntry(
            new Steps.Entry(UUID.randomUUID(), copy.id(), entry.definition().id(), order++));
      }
      applied++;
    }

    support.recordProjectChange(
        actor,
        projectId,
        "STEPS",
        "checklist applied — "
            + source.name()
            + " to "
            + applied
            + (applied == 1 ? " sub-module on " : " sub-modules on ")
            + moduleName
            + (applied == targets.size() ? "" : ", skipping those that already had it"));
    support.bump(projectId);
    return applied;
  }


  // ---------------------------------------------------------------------------
  // Defaults for a newly created sub-module
  // ---------------------------------------------------------------------------

  /**
   * Copies a module's checklists onto a sub-module that has just been created.
   *
   * <p>The companion to {@link #applyToModule}, and the half it was missing. Bulk-apply solves
   * "attach this to the two hundred sub-modules that already exist"; this solves the one created
   * next month, which otherwise starts bare and depends on somebody remembering. A default that
   * has to be remembered is not a default.
   *
   * <p>A checklist attached to the <em>module</em> is the template. That is not a new concept
   * bolted on: {@link Scope} already says a module holds its own checklist until it has
   * sub-modules, at which point they hold it instead — so copying down at the moment a
   * sub-module appears is the rule being carried out rather than an exception to it.
   *
   * <p>Copied, never linked. Ticking a step on one sub-module must not tick it on forty, which
   * is the same decision bulk-apply makes and for the same reason.
   *
   * <p>Silent and best-effort by design: creating a sub-module must not fail because the
   * template is empty, or archived, or because no module row exists for the name yet. The
   * audit line says how many were attached, and zero is a perfectly ordinary answer.
   *
   * @return how many checklists were attached.
   */
  @Transactional
  public int applyModuleDefaults(Actor actor, UUID subModuleId, String moduleName) {
    UUID projectId = actor.projectId();

    Optional<Modules.Module> module =
        projects.config(projectId).moduleNamed(moduleName).filter(found -> !found.isArchived());
    if (module.isEmpty()) {
      return 0;
    }

    StepData data = steps.load(projectId);
    List<Steps.StepList> templates =
        steps.listsFor(projectId, Scope.MODULE, module.get().id()).stream()
            .filter(list -> !list.isArchived())
            .toList();

    int attached = 0;
    for (Steps.StepList template : templates) {
      Steps.ResolvedList resolved = data.resolveOne(template);
      if (resolved.entries().isEmpty()) {
        // A template with no steps on it would produce an empty checklist, which reads on the
        // screen as a feature somebody forgot to finish rather than as nothing to do.
        continue;
      }

      Steps.StepList copy =
          new Steps.StepList(
              UUID.randomUUID(),
              projectId,
              template.name(),
              Scope.SUB_MODULE,
              subModuleId,
              template.enforceOrder(),
              null,
              Instant.now());
      steps.insertList(copy);

      int order = 0;
      for (Steps.ResolvedEntry entry : resolved.entries()) {
        steps.insertEntry(
            new Steps.Entry(UUID.randomUUID(), copy.id(), entry.definition().id(), order++));
      }
      attached++;
    }

    if (attached > 0) {
      support.record(
          actor,
          projectId,
          Audit.Scope.MODULE,
          "STEPS",
          attached == 1
              ? "checklist attached from the " + moduleName + " default"
              : attached + " checklists attached from the " + moduleName + " defaults",
          subModuleId,
          null);
    }
    return attached;
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

    AuditTarget where = scopeOf(projectId, list);
    announce(actor, list, entry, definition, target, reason, where);
    support.record(
        actor,
        projectId,
        where.auditScope(),
        "STEPS",
        definition.name()
            + " — "
            + StepGate.describe(current, target)
            + onBehalf
            + (target == Steps.State.BLOCKED ? " — " + reason.trim() : ""),
        where.subModuleId(),
        where.subActivityId());
    support.bump(projectId);
  }

  /**
   * Tells the people who are waiting.
   *
   * <p>Two events, and only two. Every other state change on a checklist concerns the person who
   * made it and nobody else, and notifying on all of them is how a tool becomes noisy on day
   * three, gets muted, and loses the channel permanently.
   *
   * <ul>
   *   <li><strong>Blocked</strong> goes to the owners of the thing, with the reason. They are
   *       the people who can unstick it, and "blocked" with no reason tells nobody anything.
   *   <li><strong>Done</strong>, on an ordered list, goes to whoever may tick the step it just
   *       unblocked. This is the one that made notifications stop being optional: a strict
   *       order blocks the owner of step 2 until step 1 is ticked, and nothing else would ever
   *       tell them it was.
   * </ul>
   */
  private void announce(
      Actor actor,
      Steps.StepList list,
      Steps.Entry entry,
      Steps.Definition definition,
      Steps.State target,
      String reason,
      AuditTarget where) {

    String link = where.subModuleId() == null ? "/matrix" : "/sub-modules/" + where.subModuleId();

    if (target == Steps.State.BLOCKED) {
      Set<UUID> ownerIds =
          owners.findByScope(actor.projectId(), list.scopeType(), list.scopeId()).stream()
              .map(Owners.Owner::userId)
              .collect(java.util.stream.Collectors.toUnmodifiableSet());

      notifications.notify(
          actor,
          ownerIds,
          Notifications.Kind.STEP_BLOCKED,
          definition.name() + " is blocked",
          reason == null ? "" : reason.trim(),
          link);
      return;
    }

    if (target != Steps.State.DONE || !list.enforceOrder()) {
      return;
    }

    // Re-read, so the freshly-ticked state is in it. `nextTickable` is asking what is true now,
    // not what was true when this method was entered.
    Steps.ResolvedList resolved = steps.load(actor.projectId()).resolveOne(list);
    nextTickable(resolved, entry.id())
        .ifPresent(
            next ->
                notifications.notify(
                    actor,
                    notifications.holdersOf(actor, next.definition().roleIds()),
                    Notifications.Kind.STEP_READY,
                    next.definition().name() + " is ready to tick",
                    actor.who()
                        + " finished \""
                        + definition.name()
                        + "\" on "
                        + list.name()
                        + ", which was the last thing in the way.",
                    link));
  }

  /**
   * The step that just became tickable, if one did.
   *
   * <p>The entry after the one that moved, and only when everything before it is now done — a
   * list can have two outstanding steps, and ticking the first of them unblocks nobody.
   */
  private static Optional<Steps.ResolvedEntry> nextTickable(
      Steps.ResolvedList list, UUID justTicked) {

    List<Steps.ResolvedEntry> entries = list.entries();
    for (int i = 0; i < entries.size(); i++) {
      if (!entries.get(i).entry().id().equals(justTicked)) {
        continue;
      }
      if (i + 1 >= entries.size()) {
        return Optional.empty();
      }

      Steps.ResolvedEntry next = entries.get(i + 1);
      if (next.progress().state().isDone()) {
        return Optional.empty();
      }
      // Everything before it has to be done, not just the one that moved.
      boolean clear =
          entries.subList(0, i + 1).stream().allMatch(e -> e.progress().state().isDone());
      return clear ? Optional.of(next) : Optional.empty();
    }
    return Optional.empty();
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
  private record AuditTarget(Audit.Scope auditScope, UUID subModuleId, UUID subActivityId) {}

  private AuditTarget scopeOf(UUID projectId, Steps.StepList list) {
    return switch (list.scopeType()) {
      case MODULE -> new AuditTarget(Audit.Scope.PROJECT, null, null);
      case SUB_MODULE -> new AuditTarget(Audit.Scope.MODULE, list.scopeId(), null);
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
        yield new AuditTarget(Audit.Scope.MODULE, parent, list.scopeId());
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
   * <p><strong>Module scope became reachable on 17 Sept</strong>, when modules gained ids on the
   * wire. This used to refuse it, for a reason that was true when it was written and stopped
   * being true a day later: a module arrived as a name and there was nothing to attach a list to.
   * It now resolves like the other two.
   *
   * <p>A module-scoped list is the module's <strong>template</strong>: {@link
   * #applyModuleDefaults} copies it onto each sub-module as that sub-module is created. That is
   * the rule in {@link Scope} rather than an addition to it — a module holds its own checklist
   * until it has sub-modules, at which point they hold it instead.
   */
  private void requireScope(UUID projectId, Scope scopeType, UUID scopeId) {
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
      case MODULE -> {
        if (projects.config(projectId).moduleById(scopeId).isEmpty()) {
          throw ServiceException.notFound("That module is not in this project.");
        }
      }
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
