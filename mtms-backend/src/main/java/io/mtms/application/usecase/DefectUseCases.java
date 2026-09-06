package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.DefectRepository;
import io.mtms.application.port.ModuleRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Defects;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Logging defects and moving them along. */
@Service
public class DefectUseCases {

  private final DefectRepository defects;
  private final ModuleRepository modules;
  private final MutationSupport support;

  public DefectUseCases(
      DefectRepository defects, ModuleRepository modules, MutationSupport support) {
    this.defects = defects;
    this.modules = modules;
    this.support = support;
  }

  @Transactional
  public UUID create(
      Actor actor,
      UUID moduleId,
      String phase,
      String severity,
      String description,
      String ticketKey,
      String childReqId) {

    actor.require(PermissionKey.DEFECT_CREATE);
    UUID projectId = actor.projectId();

    var module =
        modules
            .find(projectId, moduleId)
            .orElseThrow(() -> ServiceException.notFound("That module is not in this project."));

    Defects.Defect defect =
        new Defects.Defect(
            UUID.randomUUID(),
            projectId,
            moduleId,
            Defects.Phase.fromWire(phase),
            ticketKey == null ? "" : ticketKey,
            childReqId == null ? "" : childReqId,
            Defects.Severity.fromWire(severity),
            description,
            actor.who(),
            null,
            Defects.Status.OPEN,
            Instant.now());

    defects.insert(defect);

    support.record(
        actor, projectId, Audit.Scope.MODULE, "DEFECT",
        "defect raised — " + defect.severity().wire() + ", " + defect.phase().wire(),
        moduleId, null);

    support.emit(
        actor, projectId, Audit.DomainEventName.DEFECT_RAISED, moduleId.toString(),
        Map.of(
            "defect_id", defect.id().toString(),
            "module_id", moduleId.toString(),
            "severity", defect.severity().wire(),
            "module", module.label()));

    support.bump(projectId);
    return defect.id();
  }

  /**
   * Changes a defect.
   *
   * @param status omitted cycles Open ▸ Investigating ▸ Fixed and wraps, which is how the table
   *     advances one with a click. Supplied, it is set outright.
   */
  @Transactional
  public void update(Actor actor, UUID defectId, String status, String assignee, boolean assigneePresent) {
    UUID projectId = actor.projectId();
    Defects.Defect defect =
        defects
            .find(projectId, defectId)
            .orElseThrow(() -> ServiceException.notFound("That defect is not in this project."));

    Defects.Defect updated = defect;

    if (status != null || !assigneePresent) {
      actor.require(PermissionKey.DEFECT_TRANSITION);
      Defects.Status next =
          status == null ? defect.status().next() : Defects.Status.fromWire(status);

      updated = withStatus(updated, next);

      support.record(
          actor, projectId, Audit.Scope.MODULE, "DEFECT",
          "defect " + defect.status().wire() + " → " + next.wire(), defect.moduleId(), null);

      support.emit(
          actor, projectId, Audit.DomainEventName.DEFECT_TRANSITIONED,
          defect.moduleId().toString(),
          Map.of(
              "defect_id", defect.id().toString(),
              "from", defect.status().wire(),
              "to", next.wire()));
    }

    if (assigneePresent) {
      actor.require(PermissionKey.DEFECT_ASSIGN);
      String next = assignee == null || assignee.isBlank() ? null : assignee;
      updated = withAssignee(updated, next);

      support.record(
          actor, projectId, Audit.Scope.MODULE, "DEFECT",
          "defect assigned to " + (next == null ? "nobody" : next), defect.moduleId(), null);
    }

    defects.update(updated);
    support.bump(projectId);
  }

  @Transactional
  public void delete(Actor actor, UUID defectId) {
    actor.require(PermissionKey.DEFECT_TRANSITION);
    UUID projectId = actor.projectId();

    Defects.Defect defect =
        defects
            .find(projectId, defectId)
            .orElseThrow(() -> ServiceException.notFound("That defect is not in this project."));

    defects.delete(defectId);
    support.record(
        actor, projectId, Audit.Scope.MODULE, "DEFECT", "defect deleted", defect.moduleId(), null);
    support.bump(projectId);
  }

  private static Defects.Defect withStatus(Defects.Defect defect, Defects.Status status) {
    return new Defects.Defect(
        defect.id(), defect.projectId(), defect.moduleId(), defect.phase(), defect.ticketKey(),
        defect.childReqId(), defect.severity(), defect.description(), defect.raisedBy(),
        defect.assignee(), status, defect.createdAt());
  }

  private static Defects.Defect withAssignee(Defects.Defect defect, String assignee) {
    return new Defects.Defect(
        defect.id(), defect.projectId(), defect.moduleId(), defect.phase(), defect.ticketKey(),
        defect.childReqId(), defect.severity(), defect.description(), defect.raisedBy(),
        assignee, defect.status(), defect.createdAt());
  }
}
