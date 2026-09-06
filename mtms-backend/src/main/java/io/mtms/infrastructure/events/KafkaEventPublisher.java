package io.mtms.infrastructure.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.mtms.application.port.EventPublisher;
import io.mtms.domain.model.Audit;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

/**
 * Publishes drained outbox events to Kafka.
 *
 * <p>The partition key is the point. Everything about one module carries the same key, so a
 * consumer sees "cell changed" before "module closed" for that module — which matters, because
 * the second is only meaningful in light of the first. Ordering across different modules is not
 * promised and is not needed.
 *
 * <p>Sends are awaited rather than fired and forgotten. The drain's entire job is to find out
 * which events were accepted so it can mark exactly those published; a fire-and-forget send
 * would let it mark an event delivered that the broker never took.
 */
@Component
@ConditionalOnProperty(name = "mtms.events.publisher", havingValue = "kafka")
public class KafkaEventPublisher implements EventPublisher {

  private static final Logger log = LoggerFactory.getLogger(KafkaEventPublisher.class);

  private final KafkaTemplate<String, String> kafka;
  private final ObjectMapper objectMapper;
  private final String topic;

  public KafkaEventPublisher(
      KafkaTemplate<String, String> kafka,
      ObjectMapper objectMapper,
      @Value("${mtms.events.topic:mtms.domain-events}") String topic) {
    this.kafka = kafka;
    this.objectMapper = objectMapper;
    this.topic = topic;
  }

  @Override
  public List<Audit.DomainEvent> publish(List<Audit.DomainEvent> events) {
    List<Audit.DomainEvent> accepted = new ArrayList<>(events.size());

    for (Audit.DomainEvent event : events) {
      try {
        String body = objectMapper.writeValueAsString(event);
        kafka.send(topic, event.partitionKey(), body).get();
        accepted.add(event);
      } catch (InterruptedException e) {
        // Shutting down. Stop cleanly and leave the rest pending for the next pass.
        Thread.currentThread().interrupt();
        break;
      } catch (Exception e) {
        // Stop at the first failure rather than pressing on: the broker is usually down for
        // all of them, and the remaining events keep their place in the outbox.
        log.warn("Kafka publish failed for event {}: {}", event.id(), e.getMessage());
        break;
      }
    }
    return accepted;
  }

  @Override
  public boolean isEnabled() {
    return true;
  }
}
