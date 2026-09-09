package io.mtms.infrastructure.events;

import io.mtms.application.port.EventPublisher;
import io.mtms.application.port.OutboxRepository;
import io.mtms.domain.model.Audit;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Drains the outbox.
 *
 * <p>Runs on a timer rather than being triggered by a write, because the point of the outbox is
 * that publishing is <em>decoupled</em> from the request. The user's click is finished the
 * moment the transaction commits; whether a broker was reachable a millisecond later is not
 * their problem and must not be their latency.
 *
 * <p>Safe to run on every instance simultaneously: {@code claimPending} takes its batch with
 * {@code FOR UPDATE SKIP LOCKED}, so two instances get disjoint sets rather than the same one
 * twice. No leader election, no scheduler lock, and one fewer thing to operate.
 */
@Component
public class OutboxDrainJob {

  private static final Logger log = LoggerFactory.getLogger(OutboxDrainJob.class);
  private static final int BATCH_SIZE = 100;

  private final OutboxRepository outbox;
  private final EventPublisher publisher;

  public OutboxDrainJob(OutboxRepository outbox, EventPublisher publisher) {
    this.outbox = outbox;
    this.publisher = publisher;
  }

  @Scheduled(fixedDelayString = "${mtms.events.drain-interval-ms:5000}")
  public void drain() {
    try {
      List<Audit.DomainEvent> pending = outbox.claimPending(BATCH_SIZE);
      if (pending.isEmpty()) {
        return;
      }

      List<Audit.DomainEvent> published = publisher.publish(pending);
      if (!published.isEmpty()) {
        outbox.markPublished(published.stream().map(Audit.DomainEvent::id).toList(), Instant.now());
      }

      // Whatever the publisher would not take stays pending and is retried next pass. Recording
      // the attempt is what stops a permanently poisoned event from failing silently forever.
      pending.stream()
          .filter(event -> !published.contains(event))
          .forEach(event -> outbox.markFailed(event.id(), "publisher did not accept the event"));

      log.debug("Drained {} of {} events", published.size(), pending.size());

    } catch (Exception e) {
      // A drain failure must never take the scheduler thread down; the next pass retries.
      log.warn("Outbox drain failed, retrying next pass: {}", e.getMessage());
    }
  }
}
