package io.mtms.domain.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Defects.
 *
 * <p>A defect here references a ticket and links out to it. This is deliberately not a second
 * ticket store: ticket bodies, comments and history are never copied in, because a copy goes
 * stale and then people argue with it.
 */
public final class Defects {

  private Defects() {}

  public enum Phase {
    STAGING_TEST("Staging test"),
    PREPROD_TEST("Preprod test"),
    PROD_DEPLOYMENT("Prod deployment");

    private final String wire;

    Phase(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public static Phase fromWire(String wire) {
      for (Phase phase : values()) {
        if (phase.wire.equals(wire)) {
          return phase;
        }
      }
      throw new IllegalArgumentException("Unknown defect phase: " + wire);
    }
  }

  public enum Severity {
    HIGH("High"),
    MED("Med"),
    LOW("Low");

    private final String wire;

    Severity(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public static Severity fromWire(String wire) {
      for (Severity severity : values()) {
        if (severity.wire.equals(wire)) {
          return severity;
        }
      }
      throw new IllegalArgumentException("Unknown severity: " + wire);
    }
  }

  /** Open ▸ Investigating ▸ Fixed. The table cycles a defect through these in order. */
  public enum Status {
    OPEN("Open"),
    INVESTIGATING("Investigating"),
    FIXED("Fixed");

    private final String wire;

    Status(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public static Status fromWire(String wire) {
      for (Status status : values()) {
        if (status.wire.equals(wire)) {
          return status;
        }
      }
      throw new IllegalArgumentException("Unknown defect status: " + wire);
    }

    /** Wraps, so clicking a Fixed defect reopens it rather than doing nothing. */
    public Status next() {
      List<Status> order = ORDER;
      return order.get((order.indexOf(this) + 1) % order.size());
    }
  }

  public static final List<Status> ORDER = List.of(Status.OPEN, Status.INVESTIGATING, Status.FIXED);

  /**
   * @param ticketKey the key in whatever tracker the team actually uses. May be empty — a defect
   *     found in a call is still worth recording before anyone has raised a ticket for it.
   * @param childReqId CHILD_REQ_ID, a bare integer identifying the run this was found in.
   */
  public record Defect(
      UUID id,
      UUID projectId,
      UUID moduleId,
      Phase phase,
      String ticketKey,
      String childReqId,
      Severity severity,
      String description,
      String raisedBy,
      String assignee,
      Status status,
      Instant createdAt) {}
}
