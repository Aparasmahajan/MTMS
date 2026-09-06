/**
 * The rules. This package depends on nothing.
 *
 * <p>No Spring annotations, no JDBC, no HTTP, no {@code Instant.now()}. Everything here is a
 * pure function of its arguments, which is what makes it testable as a truth table and
 * portable to the TypeScript implementation in {@code lib/shared/}.
 *
 * <p>That restriction is not tidiness. The Java service and the Next.js service must agree
 * about what a percentage means, and the only way to keep two implementations honest is to
 * keep the thing they share small, pure, and covered by tests that run the same cases on both
 * sides. A dependency on a data source in here would end that immediately.
 *
 * <p>If you are about to add an import from {@code org.springframework} to this package, the
 * class belongs in {@code application} instead.
 */
package io.mtms.domain;
