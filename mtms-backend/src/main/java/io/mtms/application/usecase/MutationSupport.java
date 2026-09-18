package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.port.AuditRepository;
import io.mtms.application.port.OutboxRepository;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.model.Audit;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * The three things every mutation does besides the change itself.
 *
 * <p>Record what happened, record the event, move the revision. Getting one of those wrong is not
 * a visible bug — the change still lands — so it is exactly the kind of thing that rots when it
 * is copied into twenty-five methods. Here it is one object that mutations call, and a use case
 * that forgets to call it is conspicuous.
 *
 * <p>Everything here runs inside the caller's transaction. That is what makes the audit entry,
 * the outbox row and the revision bump atomic with the change they describe: there is no state
 * in which the cell moved but nobody recorded it.
 */
@Component
public class MutationSupport {

  private final AuditRepository audit;
  private final OutboxRepository outbox;
  private final ProjectRepository projects;

  public MutationSupport(
      AuditRepository audit, OutboxRepository outbox, ProjectRepository projects) {
    this.audit = audit;
    this.outbox = outbox;
    this.projects = projects;
  }

  /**
   * Records a change in the project's audit feed.
   *
   * <p>A deliverable status is only part of the record. Who created a sub-module, who broke it into
   * sub-activities and who dropped a column are all things a release manager has to be able to
   * answer months later, so they go through here too.
   */
  public void record(
      Actor actor,
      UUID projectId,
      Audit.Scope scope,
      String label,
      String what,
      UUID subModuleId,
      UUID subActivityId) {

    audit.append(
        new Audit.AuditEntry(
            UUID.randomUUID(),
            projectId,
            subModuleId,
            subActivityId,
            scope,
            label,
            what,
            actor.who(),
            Instant.now()));
  }

  /** The common case: a project-level change with no module attached. */
  public void recordProjectChange(Actor actor, UUID projectId, String label, String what) {
    record(actor, projectId, Audit.Scope.PROJECT, label, what, null, null);
  }

  /**
   * Writes a domain event to the outbox.
   *
   * @param partitionKey everything about one sub-module must share a key, so its events stay in
   *     order relative to each other once they reach Kafka.
   */
  public void emit(
      Actor actor,
      UUID projectId,
      Audit.DomainEventName name,
      String partitionKey,
      Map<String, Object> payload) {

    outbox.record(
        new Audit.DomainEvent(
            UUID.randomUUID(),
            name,
            actor.tenantId(),
            projectId,
            partitionKey,
            payload,
            Instant.now(),
            actor.who(),
            null,
            0,
            null));
  }

  /**
   * Moves the project's revision.
   *
   * <p>Must be called by every mutation, and it is the last thing that happens. The revision is
   * the snapshot cache key: until it moves, a cached projection of the previous state is still
   * reachable, and a mutation that forgets this leaves users looking at their own change not
   * having happened.
   */
  public long bump(UUID projectId) {
    return projects.bumpRevision(projectId);
  }

  /**
   * Moves the revision of every project in one organisation.
   *
   * <p>For the changes that are not about a project's contents but about the <em>set</em> of
   * projects, or about who may see them: creating, renaming or archiving a project, and granting
   * or revoking a membership. A snapshot carries the whole project list and the reader's own
   * permissions, so a user sitting in project A holds a cached answer that a change to project B
   * has just invalidated — and {@link #bump(UUID)} on B alone would leave them looking at a stale
   * switcher until they happened to edit something.
   *
   * <p>One statement per project rather than one for the organisation, because the revision lives
   * on the project row and is what the cache key is built from.
   */
  public void bumpEveryProjectIn(UUID tenantId) {
    projects.findAllByTenant(tenantId).forEach(project -> projects.bumpRevision(project.id()));
  }
}
