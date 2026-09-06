package io.mtms.infrastructure.events;

import io.mtms.application.port.EventPublisher;
import io.mtms.domain.model.Audit;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * The default publisher: logs each event and reports it delivered.
 *
 * <p>Development needs no broker. Marking events published rather than leaving them pending is
 * the right call here — an outbox that grows forever on every developer machine is noise, and
 * the log line preserves the one thing that is actually useful without Kafka, which is seeing
 * that the event was produced at all.
 */
@Component
@ConditionalOnProperty(name = "mtms.events.publisher", havingValue = "logging", matchIfMissing = true)
public class LoggingEventPublisher implements EventPublisher {

  private static final Logger log = LoggerFactory.getLogger(LoggingEventPublisher.class);

  @Override
  public List<Audit.DomainEvent> publish(List<Audit.DomainEvent> events) {
    for (Audit.DomainEvent event : events) {
      log.info(
          "event {} key={} project={} actor={}",
          event.name().wire(),
          event.partitionKey(),
          event.projectId(),
          event.actor());
    }
    return events;
  }

  @Override
  public boolean isEnabled() {
    return false;
  }
}
