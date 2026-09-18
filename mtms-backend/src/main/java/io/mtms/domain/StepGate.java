package io.mtms.domain;

import io.mtms.domain.model.Steps;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * The three rules that decide whether a step may change state.
 *
 * <p>Pure, and deliberately so: given a list, an actor's roles and a target state, these say yes
 * or no and never touch storage. The use case calls them to decide, the projection calls the same
 * functions to tell the screen <em>why</em> a control is disabled, and the two therefore cannot
 * drift into disagreeing — which is the failure this file exists to prevent, because a control
 * that looks enabled and then refuses is worse than one that was never offered.
 *
 * <p>The rules, in the order they are checked:
 *
 * <ol>
 *   <li><strong>Order</strong>, when the list enforces one. A step whose predecessors are not
 *       done cannot be ticked.
 *   <li><strong>Role.</strong> Only a role named on the step definition may tick it, unless the
 *       actor holds an override, which is recorded as an override rather than as an ordinary
 *       tick.
 *   <li><strong>Reason.</strong> Blocking needs one in writing.
 * </ol>
 */
public final class StepGate {

  private StepGate() {}

  /**
   * Why this entry cannot be ticked yet, when the list enforces its order.
   *
   * <p>Names the first step standing in the way rather than saying "out of order", because the
   * question the person is actually asking is which one, and the answer is already here.
   *
   * <p>Only ticking is gated. Un-ticking and blocking are always allowed: a sequence is a claim
   * about the order work is <em>done</em> in, never a reason to stop somebody recording that
   * something they had marked done is not, in fact, done.
   */
  public static Optional<String> orderBlocker(Steps.ResolvedList list, UUID entryId) {
    if (!list.list().enforceOrder()) {
      return Optional.empty();
    }

    List<Steps.ResolvedEntry> entries = list.entries();
    int position = -1;
    for (int i = 0; i < entries.size(); i++) {
      if (entries.get(i).entry().id().equals(entryId)) {
        position = i;
        break;
      }
    }
    if (position <= 0) {
      return Optional.empty();
    }

    for (int i = 0; i < position; i++) {
      Steps.ResolvedEntry earlier = entries.get(i);
      if (!earlier.progress().state().isDone()) {
        return Optional.of(earlier.definition().name());
      }
    }
    return Optional.empty();
  }

  /**
   * Whether these roles may tick this step in their own right.
   *
   * <p>A step with no roles named on it can be ticked by nobody. That is intentional and is the
   * safe direction: a definition whose last allowed role was deleted from the organisation would
   * otherwise silently become one anybody could tick, which is the opposite of what the admin who
   * gated it asked for. The screens say "needs a role" and an admin picks a new one.
   */
  public static boolean mayTick(Set<UUID> actorRoleIds, Steps.Definition definition) {
    if (definition.roleIds().isEmpty()) {
      return false;
    }
    return definition.roleIds().stream().anyMatch(actorRoleIds::contains);
  }

  /**
   * The wording for a step nobody currently holding these roles may tick.
   *
   * <p>Written from the roles rather than from the permission system, because this gate is not a
   * permission: it is the admin's statement about who checks this particular thing.
   */
  public static String deniedReason(Steps.Definition definition, List<String> allowedRoleNames) {
    if (definition.roleIds().isEmpty() || allowedRoleNames.isEmpty()) {
      return "\""
          + definition.name()
          + "\" names no role that still exists, so nobody can tick it."
          + " An admin picks one on the Configure screen; everything already recorded stands.";
    }
    return "Only " + String.join(" or ", allowedRoleNames) + " may tick \"" + definition.name() + "\".";
  }

  /**
   * A block must say why.
   *
   * <p>Enforced in the domain and again by a CHECK constraint in the schema. Two guards for one
   * rule is right here: the constraint is what makes it true of the data forever, and this is
   * what turns a violation into a sentence the user can act on rather than a driver exception.
   */
  public static boolean reasonRequired(Steps.State target, String reason) {
    return target == Steps.State.BLOCKED && (reason == null || reason.isBlank());
  }

  /** "not done → done", as the change feed prints it. */
  public static String describe(Steps.State from, Steps.State to) {
    return label(from) + " → " + label(to);
  }

  private static String label(Steps.State state) {
    return switch (state) {
      case TODO -> "not done";
      case DONE -> "done";
      case BLOCKED -> "blocked";
    };
  }
}
