package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.ModuleRepository;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.StatusVocabulary;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Changing a deliverable status — the interaction the whole application is built around.
 *
 * <p>Clicking a cell advances it through its column's configured statuses and wraps. No modal, no
 * dropdown: the sheet this replaced was edited by people on calls, and a click that takes one
 * gesture gets done while a form that takes six does not.
 */
@Service
public class CellUseCases {

  private final ProjectRepository projects;
  private final ModuleRepository modules;
  private final ModuleReadiness readiness;
  private final MutationSupport support;

  public CellUseCases(
      ProjectRepository projects,
      ModuleRepository modules,
      ModuleReadiness readiness,
      MutationSupport support) {
    this.projects = projects;
    this.modules = modules;
    this.readiness = readiness;
    this.support = support;
  }

  public record AdvanceCommand(
      UUID moduleId, UUID subactivityId, String columnKey, String explicitStatus) {}

  /**
   * Advances one cell.
   *
   * @param command {@code explicitStatus} is optional. Omitted, the cell advances through its
   *     column's cycle — which is what the matrix sends. Supplied, it is honoured only if the
   *     column allows it, because a client is not permitted to invent a status.
   */
  @Transactional
  public void advance(Actor actor, AdvanceCommand command) {
    actor.require(PermissionKey.DELIVERABLE_UPDATE);

    UUID projectId = actor.projectId();
    Modules.Module module = requireModule(projectId, command.moduleId());
    Projects.DeliverableColumn column = requireColumn(projectId, command.columnKey());

    if (module.isClosed()) {
      throw ServiceException.badRequest(
          "This module is closed. Reopen it before changing a deliverable.");
    }

    List<Modules.Subactivity> subs = modules.subactivities(module.id());

    // A module with subactivities has no row of its own — its cells are a roll-up. Refused
    // here as well as disabled in the UI, because the UI is not the enforcement point.
    if (command.subactivityId() == null && !subs.isEmpty()) {
      throw ServiceException.badRequest(
          "This module has subactivities, so its row is a roll-up. Change the subactivity instead.");
    }
    if (command.subactivityId() != null
        && subs.stream().noneMatch(sub -> sub.id().equals(command.subactivityId()))) {
      throw ServiceException.notFound("That subactivity is not on this module.");
    }

    String current =
        modules
            .cell(module.id(), command.subactivityId(), column.key())
            .map(Modules.Cell::status)
            .orElse(StatusVocabulary.BLANK);

    String next;
    if (command.explicitStatus() != null) {
      if (!column.allowed().contains(command.explicitStatus())) {
        throw ServiceException.validation(
            column.label()
                + " cannot take that status. It allows: "
                + column.allowed().stream()
                    .map(key -> StatusVocabulary.statusEntry(key).label())
                    .reduce((a, b) -> a + ", " + b)
                    .orElse("nothing")
                + ".");
      }
      next = command.explicitStatus();
    } else {
      next = StatusVocabulary.nextStatus(current, column.allowed());
    }

    modules.upsertCell(
        new Modules.Cell(
            module.id(),
            command.subactivityId(),
            column.key(),
            next,
            actor.who(),
            Instant.now()));

    support.record(
        actor,
        projectId,
        Audit.Scope.CELL,
        column.label(),
        StatusVocabulary.statusEntry(current).label()
            + " → "
            + StatusVocabulary.statusEntry(next).label(),
        module.id(),
        command.subactivityId());

    // Partitioned by module, so a consumer sees one module's cell changes in the order they
    // happened even when several people are editing different modules at once.
    support.emit(
        actor,
        projectId,
        Audit.DomainEventName.CELL_CHANGED,
        module.id().toString(),
        Map.of(
            "module_id", module.id().toString(),
            "column_key", column.key(),
            "from", current,
            "to", next));

    support.bump(projectId);
  }

  /**
   * DevOps confirming the whole row at once.
   *
   * <p>Sets every <em>counted</em> column to its done status. Columns whose vocabulary has no
   * done status are skipped rather than forced — a column that only goes "not raised → raised"
   * has no notion of being loaded in prod, and inventing one would put a tick where nothing
   * happened.
   */
  @Transactional
  public int confirmLoadedInProd(Actor actor, UUID moduleId) {
    actor.require(PermissionKey.PROD_CONFIRM);

    UUID projectId = actor.projectId();
    Modules.Module module = requireModule(projectId, moduleId);
    if (module.isClosed()) {
      throw ServiceException.badRequest("This module is closed.");
    }

    List<Modules.Subactivity> subs = modules.subactivities(module.id());
    List<UUID> targets = subs.isEmpty() ? java.util.Collections.singletonList(null)
        : subs.stream().map(Modules.Subactivity::id).toList();

    Instant at = Instant.now();
    int changed = 0;

    for (Projects.DeliverableColumn column : projects.columns(projectId)) {
      if (!column.counts()) {
        continue;
      }
      String done =
          column.allowed().stream()
              .filter(status -> StatusVocabulary.toneOf(status) == StatusVocabulary.Tone.DONE)
              .findFirst()
              .orElse(null);
      if (done == null) {
        continue;
      }

      for (UUID target : targets) {
        String current =
            modules
                .cell(module.id(), target, column.key())
                .map(Modules.Cell::status)
                .orElse(StatusVocabulary.BLANK);

        if (Objects.equals(current, done)) {
          continue;
        }
        modules.upsertCell(
            new Modules.Cell(module.id(), target, column.key(), done, actor.who(), at));
        changed++;
      }
    }

    if (changed > 0) {
      support.record(
          actor,
          projectId,
          Audit.Scope.MODULE,
          "MODULE",
          "confirmed loaded in prod — " + changed + (changed == 1 ? " cell" : " cells") + " set",
          module.id(),
          null);

      support.emit(
          actor,
          projectId,
          Audit.DomainEventName.DEPLOYMENT_CONFIRMED,
          module.id().toString(),
          Map.of("module_id", module.id().toString(), "cells_changed", changed));

      support.bump(projectId);
    }
    return changed;
  }

  /**
   * FNI sign-off: closes a module, or reopens one.
   *
   * <p>Closing is gated on readiness <strong>recomputed from storage</strong>, never on a number
   * the client sent. That is the point of the gate — the client already knows the percentage and
   * could simply lie about it.
   */
  @Transactional
  public void signOffFni(Actor actor, UUID moduleId, boolean close) {
    actor.require(PermissionKey.FNI_SIGNOFF);

    UUID projectId = actor.projectId();
    Modules.Module module = requireModule(projectId, moduleId);

    if (close) {
      List<String> blockers = readiness.fniBlockers(projectId, moduleId);
      if (!blockers.isEmpty()) {
        throw ServiceException.badRequest("Blocked — " + String.join("; ", blockers));
      }

      modules.update(
          new Modules.Module(
              module.id(), module.projectId(), module.nodeType(), module.name(),
              module.libraryEntryId(), module.owner(), module.fniTargetDate(),
              Instant.now(), actor.who(), module.createdAt()));

      support.emit(
          actor,
          projectId,
          Audit.DomainEventName.MODULE_CLOSED,
          module.id().toString(),
          Map.of(
              "module_id", module.id().toString(),
              "node_type", module.nodeType(),
              "name", module.name()));
    } else {
      modules.update(
          new Modules.Module(
              module.id(), module.projectId(), module.nodeType(), module.name(),
              module.libraryEntryId(), module.owner(), module.fniTargetDate(),
              null, null, module.createdAt()));
    }

    support.record(
        actor,
        projectId,
        Audit.Scope.MODULE,
        "FNI",
        close ? "FNI signed off — module closed" : "module reopened",
        module.id(),
        null);

    support.bump(projectId);
  }

  private Modules.Module requireModule(UUID projectId, UUID moduleId) {
    return modules
        .find(projectId, moduleId)
        .orElseThrow(() -> ServiceException.notFound("That module is not in this project."));
  }

  private Projects.DeliverableColumn requireColumn(UUID projectId, String columnKey) {
    return projects
        .column(projectId, columnKey)
        .orElseThrow(() -> ServiceException.notFound("That column is not configured here."));
  }
}
