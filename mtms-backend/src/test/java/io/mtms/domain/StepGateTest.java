package io.mtms.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.mtms.domain.model.Steps;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * The rules that decide whether a step may be ticked.
 *
 * <p>Written from the same angle as {@code PromotionGateTest}: what would be believed about a
 * release if this were wrong. A gate that is too loose turns the checklist into decoration —
 * anybody can say testing is done. A gate that is too tight is worse in a different way: people
 * stop recording what they did and keep the real state somewhere else.
 */
@DisplayName("the step gate")
class StepGateTest {

  private static final UUID QA = UUID.randomUUID();
  private static final UUID DEV = UUID.randomUUID();

  private static Steps.Definition step(String name, UUID... roles) {
    return new Steps.Definition(
        UUID.randomUUID(), UUID.randomUUID(), name, "", Set.of(roles), null, Instant.now());
  }

  /** A list of steps in order, with the states given. */
  private static Steps.ResolvedList list(boolean enforceOrder, Steps.State... states) {
    List<Steps.ResolvedEntry> entries = new ArrayList<>();
    for (int i = 0; i < states.length; i++) {
      Steps.Definition definition = step("step " + (i + 1), QA);
      Steps.Entry entry = new Steps.Entry(UUID.randomUUID(), UUID.randomUUID(), definition.id(), i);
      entries.add(
          new Steps.ResolvedEntry(
              entry,
              definition,
              new Steps.Progress(entry.id(), states[i], null, null, null)));
    }

    return new Steps.ResolvedList(
        new Steps.StepList(
            UUID.randomUUID(),
            UUID.randomUUID(),
            "config1",
            Steps.ScopeType.SUB_MODULE,
            UUID.randomUUID(),
            enforceOrder,
            null,
            Instant.now()),
        List.copyOf(entries));
  }

  @Nested
  @DisplayName("order")
  class Order {

    @Test
    @DisplayName("a list that does not enforce an order never blocks anything")
    void unordered() {
      Steps.ResolvedList unordered = list(false, Steps.State.TODO, Steps.State.TODO);
      UUID last = unordered.entries().get(1).entry().id();

      assertTrue(StepGate.orderBlocker(unordered, last).isEmpty());
    }

    @Test
    @DisplayName("the first step is never blocked, ordered or not")
    void first() {
      Steps.ResolvedList ordered = list(true, Steps.State.TODO, Steps.State.TODO);
      UUID first = ordered.entries().get(0).entry().id();

      assertTrue(StepGate.orderBlocker(ordered, first).isEmpty());
    }

    @Test
    @DisplayName("it names the earliest step in the way, not the nearest one")
    void namesTheEarliest() {
      // Step 1 and step 2 both outstanding. Saying "step 2 is not done" would send somebody to
      // do step 2, which they cannot do either — so the answer has to be the one at the front.
      Steps.ResolvedList ordered =
          list(true, Steps.State.TODO, Steps.State.TODO, Steps.State.TODO);
      UUID third = ordered.entries().get(2).entry().id();

      assertEquals("step 1", StepGate.orderBlocker(ordered, third).orElseThrow());
    }

    @Test
    @DisplayName("blocked is not done — an earlier blocked step still holds the list up")
    void blockedIsNotDone() {
      Steps.ResolvedList ordered = list(true, Steps.State.BLOCKED, Steps.State.TODO);
      UUID second = ordered.entries().get(1).entry().id();

      assertEquals("step 1", StepGate.orderBlocker(ordered, second).orElseThrow());
    }

    @Test
    @DisplayName("everything earlier being done clears the way")
    void clear() {
      Steps.ResolvedList ordered = list(true, Steps.State.DONE, Steps.State.DONE, Steps.State.TODO);
      UUID third = ordered.entries().get(2).entry().id();

      assertTrue(StepGate.orderBlocker(ordered, third).isEmpty());
    }
  }

  @Nested
  @DisplayName("roles")
  class Roles {

    @Test
    @DisplayName("holding any one of the named roles is enough")
    void anyOf() {
      assertTrue(StepGate.mayTick(Set.of(DEV), step("Received CIQ", QA, DEV)));
    }

    @Test
    @DisplayName("holding none of them is not")
    void noneOf() {
      assertFalse(StepGate.mayTick(Set.of(DEV), step("Testing done", QA)));
    }

    @Test
    @DisplayName("a step naming no role can be ticked by nobody, not by everybody")
    void noRolesLocksRatherThanOpens() {
      // The case that matters is a step whose last allowed role was deleted from the
      // organisation. Treating "no roles" as "unrestricted" would silently turn the most
      // carefully gated step in the project into the only one anyone can tick.
      assertFalse(StepGate.mayTick(Set.of(QA, DEV), step("Sign-off")));
    }

    @Test
    @DisplayName("the refusal names the roles, so it can be acted on")
    void refusalNamesRoles() {
      String reason = StepGate.deniedReason(step("Testing done", QA), List.of("QA", "SME"));

      assertTrue(reason.contains("QA or SME"), reason);
      assertTrue(reason.contains("Testing done"), reason);
    }

    @Test
    @DisplayName("a step whose roles have all been deleted says so, rather than naming nobody")
    void refusalWhenRolesAreGone() {
      String reason = StepGate.deniedReason(step("Sign-off"), List.of());

      assertTrue(reason.contains("no role that still exists"), reason);
      assertTrue(reason.contains("already recorded stands"), reason);
    }
  }

  @Nested
  @DisplayName("blocking")
  class Blocking {

    @Test
    @DisplayName("a block needs a reason")
    void reasonRequired() {
      assertTrue(StepGate.reasonRequired(Steps.State.BLOCKED, null));
      assertTrue(StepGate.reasonRequired(Steps.State.BLOCKED, "   "));
      assertFalse(StepGate.reasonRequired(Steps.State.BLOCKED, "waiting on the vendor"));
    }

    @Test
    @DisplayName("nothing else does")
    void onlyBlocking() {
      assertFalse(StepGate.reasonRequired(Steps.State.DONE, null));
      assertFalse(StepGate.reasonRequired(Steps.State.TODO, null));
    }
  }

  @Nested
  @DisplayName("readiness")
  class Readiness {

    @Test
    @DisplayName("blocked counts as not done, because it is not done")
    void blockedIsNotProgress() {
      assertEquals(50, list(false, Steps.State.DONE, Steps.State.BLOCKED).readiness());
    }

    @Test
    @DisplayName("an empty checklist is 0%, not 100%")
    void emptyIsZero() {
      // The other rounding would report every sub-module nobody has configured a checklist for
      // as finished, which is the opposite of what an unconfigured thing means.
      assertEquals(0, list(false).readiness());
    }
  }
}
