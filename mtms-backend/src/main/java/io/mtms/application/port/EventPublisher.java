package io.mtms.application.port;

import io.mtms.domain.model.Audit;
import java.util.List;

/**
 * Publishes domain events that have already been durably recorded.
 *
 * <p>Note what this is <em>not</em>: it is not called by a use case. A use case inserts into
 * {@code domain_events} in the same transaction as the change that produced the event, and the
 * drain job calls this afterwards. That ordering is the outbox pattern, and it is the whole
 * reason this interface exists separately from {@link OutboxRepository}.
 *
 * <p>Writing to a broker inside the transaction would make the database write and the publish
 * two things that can disagree — the broker accepts and the transaction rolls back, or the
 * transaction commits and the broker is down. Neither is recoverable after the fact. Recording
 * the event next to the change makes "the cell changed" and "the event exists" one fact.
 *
 * <p>Delivery is therefore at-least-once, and consumers must be idempotent. Every event carries
 * a stable id for exactly that.
 */
public interface EventPublisher {

  /**
   * Publishes a batch, returning the events that were accepted.
   *
   * <p>Returning the successes rather than throwing on the first failure is deliberate: a batch
   * of fifty where the eleventh fails should still mark the first ten published, or the drain
   * will republish them on every pass forever.
   */
  List<Audit.DomainEvent> publish(List<Audit.DomainEvent> events);

  /** Whether a broker is actually configured. False in development, and that is fine. */
  boolean isEnabled();
}
