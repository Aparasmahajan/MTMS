package io.mtms.domain.model;

import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * Steps — the reusable checklist.
 *
 * <p>In one sentence: an admin writes each step once, then attaches a named, ordered list of
 * them to whichever modules and sub-modules need it, and only the right role may tick each one.
 *
 * <p>Three things are deliberately kept apart, and keeping them apart is what makes the
 * checklist reusable rather than forty copies of the same list:
 *
 * <ol>
 *   <li>{@link Definition} — the library. "Received CIQ", written once, with the roles allowed
 *       to tick it.
 *   <li>{@link StepList} and {@link Entry} — one named configuration attached to one thing, in a
 *       chosen order. <strong>The order lives on the entry, not on the definition</strong>: the
 *       same step is first in one sub-module's list and third in another's, and storing the
 *       order on the step would make those two facts contradict each other.
 *   <li>{@link Progress}, {@link Event} and {@link Comment} — what actually happened.
 *       {@code Progress} is only a fast lookup; {@code Event} is append-only and is the truth.
 *       If the two ever disagree, the events win.
 * </ol>
 *
 * <p>Nothing here is ever hard-deleted where a person wrote something. Archiving hides a row and
 * leaves its history underneath — retiring a step used by forty sub-modules must not destroy
 * forty records of work that was genuinely done.
 */
public final class Steps {

  private Steps() {}

  /**
   * Where a step stands.
   *
   * <p>Three states, not two. "Blocked" is the one that earns its place: a step sitting at
   * not-done because nobody has got to it and a step sitting at not-done because a third party
   * has not answered are different problems, and only one of them is anybody's to fix today.
   * A block always carries a written reason — "blocked" on its own tells nobody anything.
   */
  public enum State {
    TODO("todo"),
    DONE("done"),
    BLOCKED("blocked");

    private final String wire;

    State(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public boolean isDone() {
      return this == DONE;
    }

    public static State fromWire(String wire) {
      String value = wire == null ? "" : wire.trim().toLowerCase(Locale.ROOT);
      for (State state : values()) {
        if (state.wire.equals(value)) {
          return state;
        }
      }
      throw new IllegalArgumentException("Unknown step state: " + wire);
    }
  }

  /**
   * What a checklist hangs off.
   *
   * <p>The rule is the lowest level that exists — the same one the matrix already uses. A module
   * with no sub-modules holds its own checklist; once it has sub-modules, they hold it instead.
   * Within an activity split into sub-activities the list sits on the activity by default, and
   * an admin pushes it down only to the sub-activities that genuinely differ.
   */
  public enum ScopeType {
    MODULE("module"),
    SUB_MODULE("sub_module"),
    SUB_ACTIVITY("sub_activity");

    private final String wire;

    ScopeType(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public static ScopeType fromWire(String wire) {
      String value = wire == null ? "" : wire.trim().toLowerCase(Locale.ROOT).replace('-', '_');
      for (ScopeType scope : values()) {
        if (scope.wire.equals(value)) {
          return scope;
        }
      }
      throw new IllegalArgumentException("Unknown scope: " + wire);
    }
  }

  /**
   * One step in the library, written once and used anywhere.
   *
   * @param roleIds who may tick it. Several are allowed — "Received CIQ" is SME or Product — and
   *     an empty set means nobody can, which the screens surface as "needs a role" rather than
   *     silently letting anyone through. A role deleted from the organisation takes its
   *     permission with it and leaves every tick already recorded exactly where it is: a
   *     settings change is not evidence that the work did not happen.
   * @param archivedAt soft delete. The step leaves every screen; its history and its comments
   *     stay.
   */
  public record Definition(
      UUID id,
      UUID projectId,
      String name,
      String description,
      Set<UUID> roleIds,
      Instant archivedAt,
      Instant createdAt) {

    public Definition {
      roleIds = roleIds == null ? Set.of() : Set.copyOf(roleIds);
      description = description == null ? "" : description;
    }

    public boolean isArchived() {
      return archivedAt != null;
    }
  }

  /**
   * One named, ordered configuration, attached to one thing.
   *
   * @param enforceOrder the admin's choice, per list. "CIQ, then testing, then prod" is
   *     genuinely sequential; "these six things in any order" is just as common, and forcing a
   *     sequence onto it would have people ticking boxes in an order they did not work in.
   */
  public record StepList(
      UUID id,
      UUID projectId,
      String name,
      ScopeType scopeType,
      UUID scopeId,
      boolean enforceOrder,
      Instant archivedAt,
      Instant createdAt) {

    public boolean isArchived() {
      return archivedAt != null;
    }
  }

  /**
   * One step's place in one list.
   *
   * <p>{@code orderIndex} is here and not on {@link Definition}. That is the whole reason this
   * table exists separately: sub-module A runs steps 1 to 2 to 3 while sub-module B, on the same
   * module, runs 5 to 4 to 6, and a step cannot be both first and third at once.
   */
  public record Entry(UUID id, UUID stepListId, UUID definitionId, int orderIndex) {}

  /**
   * Where an entry stands right now.
   *
   * <p>A fast lookup, derived from {@link Event} and never the authority. An entry nobody has
   * touched has no row at all and reads back as {@link State#TODO} — the same absence-is-a-value
   * design the cells table uses.
   */
  public record Progress(
      UUID entryId, State state, String blockedReason, UUID changedBy, Instant changedAt) {

    public static Progress todo(UUID entryId) {
      return new Progress(entryId, State.TODO, null, null, null);
    }
  }

  /**
   * Every tick and un-tick ever made. Append-only, never deleted.
   *
   * @param isOverride an admin ticking on behalf of a role that is unavailable. The record says
   *     so — "Nitin ticked this on behalf of QA" — rather than claiming QA checked it, which is
   *     the difference between an audit trail and a decoration.
   * @param byName the actor's display name, denormalised. An event outlives the account that
   *     made it; keeping only the id would turn the whole history into "unknown user" the day
   *     somebody leaves.
   */
  public record Event(
      UUID id,
      UUID entryId,
      State from,
      State to,
      boolean isOverride,
      String reason,
      UUID byUserId,
      String byName,
      Instant at) {}

  /**
   * A comment on one step.
   *
   * <p>Ticking is role-gated; commenting is not. Anyone who can see the project may write here,
   * stakeholders included — the person who knows why a step is stuck is very often not the
   * person allowed to tick it.
   */
  public record Comment(
      UUID id,
      UUID entryId,
      UUID authorId,
      String authorName,
      String body,
      Instant createdAt,
      Instant editedAt,
      Instant archivedAt) {}

  /**
   * One list with its entries resolved — what a screen actually needs.
   *
   * <p>Assembled by the projection rather than stored: a list, its entries, their definitions
   * and their current state are four tables, and every screen wants them as one thing.
   */
  public record ResolvedList(StepList list, List<ResolvedEntry> entries) {

    /** Done over entries, as a whole percentage. Blocked counts as not done, because it is not. */
    public int readiness() {
      if (entries.isEmpty()) {
        return 0;
      }
      long done = entries.stream().filter(entry -> entry.progress().state().isDone()).count();
      return (int) Math.round((done * 100.0) / entries.size());
    }
  }

  public record ResolvedEntry(Entry entry, Definition definition, Progress progress) {}
}
