package io.mtms.domain.view;

import java.util.List;

/**
 * Steps, as the screens read them.
 *
 * <p>The same contract the rest of {@link Views} keeps: the wire carries facts and the decisions
 * already made on the server, never presentation. There is one deliberate exception, and it is
 * the reason this file is worth reading — {@link StepEntryView#canTick} and {@link
 * StepEntryView#lockedReason} are <em>answers</em>, computed by the projection using the same
 * {@code StepGate} the use case will use when the click arrives.
 *
 * <p>That is not duplication of logic, it is the removal of it. The alternative is a client that
 * guesses which controls to enable from the roles and the order, guesses slightly differently
 * from the server, and produces the worst failure a permission system has: a button that looks
 * available and then refuses. Here the server says whether the control works and, when it does
 * not, gives the sentence to show — so a disabled control always explains itself.
 */
public final class StepViews {

  private StepViews() {}

  /**
   * One step in the library.
   *
   * @param roleNames who may tick it, by name, for the screens. Empty means the step names no
   *     role that still exists — nobody can tick it, and an admin has to pick one. That is the
   *     safe direction: the alternative is a step whose last role was deleted quietly becoming
   *     one anybody may tick.
   * @param usedIn how many configurations currently contain this step. The admin retiring one
   *     should know how many checklists it will leave.
   */
  public record StepDefinitionView(
      String id,
      String name,
      String description,
      List<String> roleIds,
      List<String> roleNames,
      int usedIn) {}

  /** One tick or un-tick. Append-only in storage and read-only everywhere. */
  public record StepEventView(
      String id,
      String from,
      String to,
      String what,
      boolean isOverride,
      String reason,
      String by,
      String at) {}

  /**
   * @param mine whether the reader wrote it, so the screen can offer to remove it. Removal is
   *     still checked server-side; this only decides whether to draw the control.
   */
  public record StepCommentView(
      String id, String author, String body, String createdAt, boolean mine) {}

  /**
   * One step on one checklist, with everything about it.
   *
   * @param state {@code todo}, {@code done} or {@code blocked}.
   * @param canTick whether this reader can move it to done right now — role and order both
   *     already considered.
   * @param lockedReason why not, in a sentence, or empty. Never let a control fail silently and
   *     never let one sit greyed out without saying why.
   * @param isOverrideForMe true when this reader can only act by overriding the role gate. The
   *     screen warns before they do, because the record will name them as having ticked on
   *     somebody else's behalf.
   */
  public record StepEntryView(
      String id,
      String definitionId,
      String name,
      String description,
      String state,
      String blockedReason,
      String changedBy,
      String changedAt,
      List<String> allowedRoles,
      boolean canTick,
      boolean isOverrideForMe,
      String lockedReason,
      List<StepEventView> history,
      List<StepCommentView> comments) {}

  /**
   * One named configuration, attached to one thing.
   *
   * @param enforceOrder whether the order is a real sequence. The screen draws it differently
   *     and the server refuses an out-of-turn tick, which is the half that counts.
   * @param readiness done over total, as a whole percentage. Blocked counts as not done.
   */
  public record StepListView(
      String id,
      String name,
      boolean enforceOrder,
      int readiness,
      int doneCount,
      int blockedCount,
      List<StepEntryView> entries) {}
}
