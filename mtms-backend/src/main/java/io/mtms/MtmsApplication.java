package io.mtms;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * MTMS — the tracker service.
 *
 * <p>Four layers, and the arrows only point one way:
 *
 * <pre>
 *   api  ─────┐
 *             ├──▶  application  ──▶  domain
 *   infrastructure ─┘                   (depends on nothing)
 * </pre>
 *
 * <p>{@code domain} is pure: no Spring, no SQL, no HTTP, no clock. It is the rules, and it is
 * the half of this service that has a paired implementation in TypeScript. {@code application}
 * owns the use cases and declares <em>ports</em> — interfaces it needs somebody to satisfy.
 * {@code infrastructure} satisfies them with Postgres, Redis and Kafka. {@code api} is the HTTP
 * boundary and holds no rules at all.
 *
 * <p>The direction of that dependency is the whole design. It is why the use cases can be
 * tested against in-memory ports without a database, why the storage engine is a swap rather
 * than a rewrite, and why Redis and Kafka can both be absent in development without a single
 * {@code if} appearing in a use case.
 *
 * <p>{@code @EnableScheduling} drives one thing: the outbox drain. See
 * {@code infrastructure.events.OutboxDrainJob}.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class MtmsApplication {

  public static void main(String[] args) {
    SpringApplication.run(MtmsApplication.class, args);
  }
}
