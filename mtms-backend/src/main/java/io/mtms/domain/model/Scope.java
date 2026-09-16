package io.mtms.domain.model;

import java.util.Locale;

/**
 * What a thing can hang off: a module, a sub-module, or a sub-activity.
 *
 * <p>Three features attach to the hierarchy rather than living in it — a checklist, a set of
 * owners, a discussion — and all three attach at the same three levels, by the same rule. So the
 * vocabulary is one enum rather than three that happen to agree today.
 *
 * <p><strong>The rule is "the lowest level that exists"</strong>, and it is the same one the
 * matrix already uses for cells. A module with no sub-modules holds its own; once it has
 * sub-modules, they hold it instead. Within an activity split into sub-activities the thing sits
 * on the activity by default, and an admin pushes it down only to the pieces that genuinely
 * differ.
 *
 * <p>The wire form is snake_case because it is what three database columns already store —
 * {@code step_lists.scope_type}, {@code owners.scope_type} and {@code threads.scope_type}, each
 * with a CHECK constraint naming exactly these three.
 */
public enum Scope {
  MODULE("module"),
  SUB_MODULE("sub_module"),
  SUB_ACTIVITY("sub_activity");

  private final String wire;

  Scope(String wire) {
    this.wire = wire;
  }

  public String wire() {
    return wire;
  }

  /** Hyphens are accepted as well as underscores: the API is read by people, not only by code. */
  public static Scope fromWire(String wire) {
    String value = wire == null ? "" : wire.trim().toLowerCase(Locale.ROOT).replace('-', '_');
    for (Scope scope : values()) {
      if (scope.wire.equals(value)) {
        return scope;
      }
    }
    throw new IllegalArgumentException("Unknown scope: " + wire);
  }
}
