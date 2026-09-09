package io.mtms.application.port;

import io.mtms.domain.model.Audit;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * The transactional outbox.
 *
 * <p>{@link #record} is called <em>inside</em> the same transaction as the change that produced
 * the event. {@link #claimPending} and {@link #markPublished} are called by the drain job,
 * afterwards and separately. Keeping those two halves in one interface but on opposite sides of
 * a transaction boundary is the pattern in miniature.
 */
public interface OutboxRepository {

  /** Inserts an event. Must be called in the transaction that made the change it describes. */
  void record(Audit.DomainEvent event);

  /**
   * Claims a batch of unpublished events for this instance to drain.
   *
   * <p>Implementations must use {@code SELECT ... FOR UPDATE SKIP LOCKED}. Without it two
   * application instances draining concurrently both read the same rows and publish everything
   * twice; with it each takes a disjoint batch and the other moves on rather than blocking.
   * Delivery is still at-least-once — a crash between publishing and marking will republish —
   * so consumers must be idempotent regardless.
   */
  List<Audit.DomainEvent> claimPending(int limit);

  void markPublished(List<UUID> eventIds, Instant at);

  /** Records a failed attempt so a permanently poisoned event is visible rather than silent. */
  void markFailed(UUID eventId, String error);

  int pendingCount();
}
