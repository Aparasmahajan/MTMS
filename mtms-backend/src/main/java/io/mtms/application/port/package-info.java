/**
 * Ports — the interfaces the use cases need somebody to satisfy.
 *
 * <p>Every one of these is declared <em>here</em>, next to the code that calls it, and
 * implemented over in {@code infrastructure}. That is the direction that matters: the use
 * cases do not reach out to a database package, the database package reaches in and satisfies a
 * contract the application wrote. Dependency inversion, and the reason this layer compiles
 * without Postgres, Redis or Kafka on the classpath in any meaningful sense.
 *
 * <p>What it buys, concretely:
 *
 * <ul>
 *   <li>Use cases are tested against in-memory implementations in milliseconds, with no
 *       container, no daemon and no fixture teardown.
 *   <li>Redis and Kafka are genuinely optional. {@code SnapshotCache} and {@code EventPublisher}
 *       each have a no-op implementation chosen by configuration, so development needs neither
 *       and not one {@code if} appears in a use case.
 *   <li>Swapping the storage engine is a new class in {@code infrastructure}, not a rewrite.
 * </ul>
 *
 * <p>Interfaces are kept narrow on purpose. A single fat {@code Repository} with sixty methods
 * would force every test double to implement sixty methods to exercise one, which is the
 * interface segregation principle stated as a practical annoyance rather than an initial.
 */
package io.mtms.application.port;
