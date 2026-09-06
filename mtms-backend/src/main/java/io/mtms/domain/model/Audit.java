package io.mtms.domain.model;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * The record of what happened: the project audit feed, the platform feed, and the outbox.
 *
 * <p>Three separate things on purpose. They answer different questions, have different readers,
 * and merging them would put "somebody created an organisation" into every project's change
 * feed.
 */
public final class Audit {

  private Audit() {}

  /**
   * What kind of thing changed.
   *
   * <p>A deliverable status is only part of the record. Who created a module, who broke it into
   * subactivities, and who changed the columns are all things a release manager has to be able
   * to answer months later, when the person who did it has moved teams.
   */
  public enum Scope {
    CELL("cell"),
    MODULE("module"),
    PROJECT("project");

    private final String wire;

    Scope(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public static Scope fromWire(String wire) {
      for (Scope scope : values()) {
        if (scope.wire.equals(wire)) {
          return scope;
        }
      }
      throw new IllegalArgumentException("Unknown audit scope: " + wire);
    }
  }

  /**
   * @param moduleId {@code null} for a project-level change, such as a column being added.
   * @param label the column label for a cell change; otherwise a short tag — MODULE, CONFIG,
   *     ACCESS.
   * @param what "Not Loaded → Loaded in prod", rendered verbatim in the change feeds. Composed
   *     when the change is made, because the labels it names may be edited later and the feed
   *     must keep saying what it said at the time.
   */
  public record AuditEntry(
      UUID id,
      UUID projectId,
      UUID moduleId,
      UUID subactivityId,
      Scope scope,
      String label,
      String what,
      String who,
      Instant at) {}

  /**
   * Platform actions, which have no project to be audited against.
   *
   * <p>Kept apart from {@link AuditEntry} rather than making its {@code projectId} nullable.
   */
  public record PlatformAuditEntry(
      UUID id, String action, UUID tenantId, String what, String who, Instant at) {}

  public enum DomainEventName {
    CELL_CHANGED("cell.changed"),
    MODULE_CLOSED("module.closed"),
    DEFECT_RAISED("defect.raised"),
    DEFECT_TRANSITIONED("defect.transitioned"),
    DEPLOYMENT_CONFIRMED("deployment.confirmed"),
    USER_INVITED("user.invited");

    private final String wire;

    DomainEventName(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public static DomainEventName fromWire(String wire) {
      for (DomainEventName name : values()) {
        if (name.wire.equals(wire)) {
          return name;
        }
      }
      throw new IllegalArgumentException("Unknown event name: " + wire);
    }
  }

  /**
   * A domain event, in an outbox.
   *
   * <p>The design calls for Kafka. Writing to a broker inside a transaction would make the
   * database write and the publish two things that can disagree — the classic dual-write —
   * so events are inserted into {@code domain_events} in the <em>same</em> transaction as the
   * change that produced them, and drained afterwards. That is what makes "the cell changed"
   * and "the event was recorded" one fact rather than two hopeful ones.
   *
   * @param partitionKey the Kafka partition key. Everything about one module shares a key, so
   *     its events stay in order relative to each other.
   * @param publishedAt {@code null} until the drain succeeds. The drain is at-least-once;
   *     consumers must be idempotent.
   */
  public record DomainEvent(
      UUID id,
      DomainEventName name,
      UUID tenantId,
      UUID projectId,
      String partitionKey,
      Map<String, Object> payload,
      Instant occurredAt,
      String actor,
      Instant publishedAt,
      int attempts,
      String lastError) {

    public boolean isPending() {
      return publishedAt == null;
    }
  }
}
