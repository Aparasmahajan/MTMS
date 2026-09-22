package io.mtms.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * What the timing figures claim, and what they must refuse to claim.
 *
 * <p>Written from the angle of what somebody would believe if this were wrong. These numbers will
 * be read as "CIQ takes four days" and repeated in a status meeting, so the dangerous failures are
 * not crashes — they are confident answers computed from two finished sub-modules out of sixty,
 * or a zero that means "nobody has finished this" being read as "this is instant".
 */
class TimingTest {

  private static final Instant START = Instant.parse("2026-01-01T00:00:00Z");
  private static final UUID PROJECT = UUID.randomUUID();

  private static Projects.DeliverableColumn column(String key, int order) {
    return new Projects.DeliverableColumn(
        UUID.randomUUID(), PROJECT, key, key, key, List.of("done"), true, order, null, null, null);
  }

  private static Modules.SubModule subModule(UUID id, Instant createdAt) {
    return new Modules.SubModule(
        id, PROJECT, "SBC", "activity-" + id, null, null, null, null, null, createdAt);
  }

  private static Modules.Cell done(UUID subModuleId, String columnKey, int daysLater) {
    return new Modules.Cell(
        subModuleId, null, columnKey, "done", "someone", START.plus(Duration.ofDays(daysLater)));
  }

  @Nested
  @DisplayName("The figures")
  class Figures {

    @Test
    @DisplayName("median is the middle value, not the average")
    void medianNotMean() {
      UUID a = UUID.randomUUID();
      UUID b = UUID.randomUUID();
      UUID c = UUID.randomUUID();

      // 2, 4 and 300 days. The mean is over a hundred; the median is 4. One sub-module that was
      // started and abandoned must not be able to say the work takes a hundred days.
      List<Timing.ColumnTiming> timings =
          Timing.perColumn(
              List.of(column("CIQ", 0)),
              List.of(subModule(a, START), subModule(b, START), subModule(c, START)),
              List.of(done(a, "CIQ", 2), done(b, "CIQ", 4), done(c, "CIQ", 300)),
              Set.of("done"));

      assertEquals(4.0, timings.get(0).medianDays());
      assertEquals(102.0, timings.get(0).meanDays());
    }

    @Test
    @DisplayName("addedDays is this column's median minus the previous one's")
    void addedIsTheGap() {
      UUID a = UUID.randomUUID();

      List<Timing.ColumnTiming> timings =
          Timing.perColumn(
              List.of(column("CIQ", 0), column("TEST", 1)),
              List.of(subModule(a, START)),
              List.of(done(a, "CIQ", 3), done(a, "TEST", 10)),
              Set.of("done"));

      assertNull(timings.get(0).addedDays(), "the first column has nothing to compare against");
      assertEquals(7.0, timings.get(1).addedDays(), "10 days total, 3 of them before this column");
    }
  }

  @Nested
  @DisplayName("Per step, from the append-only history")
  class PerStep {

    private final UUID definitionId = UUID.randomUUID();
    private final UUID listId = UUID.randomUUID();
    private final UUID entryId = UUID.randomUUID();

    private io.mtms.domain.model.Steps.Definition definition() {
      return new io.mtms.domain.model.Steps.Definition(
          definitionId, PROJECT, "CIQ received", "", Set.of(), null, START);
    }

    private io.mtms.domain.model.Steps.StepList list(Instant createdAt) {
      return new io.mtms.domain.model.Steps.StepList(
          listId,
          PROJECT,
          "Standard checks",
          io.mtms.domain.model.Scope.SUB_MODULE,
          UUID.randomUUID(),
          false,
          null,
          createdAt);
    }

    private io.mtms.domain.model.Steps.Entry entry() {
      return new io.mtms.domain.model.Steps.Entry(entryId, listId, definitionId, 0);
    }

    private io.mtms.domain.model.Steps.Event event(
        io.mtms.domain.model.Steps.State from,
        io.mtms.domain.model.Steps.State to,
        int daysLater) {
      return new io.mtms.domain.model.Steps.Event(
          UUID.randomUUID(),
          entryId,
          from,
          to,
          false,
          null,
          null,
          "someone",
          START.plus(Duration.ofDays(daysLater)));
    }

    @Test
    @DisplayName("measures from the checklist being attached to the tick")
    void oneGo() {
      List<Timing.StepTiming> timings =
          Timing.perStep(
              List.of(definition()),
              List.of(list(START)),
              List.of(entry()),
              List.of(
                  event(
                      io.mtms.domain.model.Steps.State.TODO,
                      io.mtms.domain.model.Steps.State.DONE,
                      11)));

      assertEquals(11.0, timings.get(0).medianDays());
      assertEquals(1, timings.get(0).completions());
      assertEquals(0, timings.get(0).outstanding());
    }

    @Test
    @DisplayName("ticked, un-ticked and ticked again is two durations, not one long span")
    void reTickIsTwoDurations() {
      // Attached day 0. Ticked day 2. Un-ticked day 20. Ticked again day 23.
      //
      // The whole reason this reads events rather than cells: a first-to-last reading would
      // report 23 days, which is wildly wrong exactly on the work that went badly — and that is
      // the work anybody is asking about. The true answer is two goes of 2 and 3 days.
      List<Timing.StepTiming> timings =
          Timing.perStep(
              List.of(definition()),
              List.of(list(START)),
              List.of(entry()),
              List.of(
                  event(
                      io.mtms.domain.model.Steps.State.TODO,
                      io.mtms.domain.model.Steps.State.DONE,
                      2),
                  event(
                      io.mtms.domain.model.Steps.State.DONE,
                      io.mtms.domain.model.Steps.State.TODO,
                      20),
                  event(
                      io.mtms.domain.model.Steps.State.TODO,
                      io.mtms.domain.model.Steps.State.DONE,
                      23)));

      assertEquals(2, timings.get(0).completions(), "two goes, not one");
      assertEquals(2.5, timings.get(0).medianDays(), "the median of 2 and 3, not 23");
    }

    @Test
    @DisplayName("a step un-ticked and left that way is outstanding again")
    void unTickedIsOutstandingAgain() {
      List<Timing.StepTiming> timings =
          Timing.perStep(
              List.of(definition()),
              List.of(list(START)),
              List.of(entry()),
              List.of(
                  event(
                      io.mtms.domain.model.Steps.State.TODO,
                      io.mtms.domain.model.Steps.State.DONE,
                      2),
                  event(
                      io.mtms.domain.model.Steps.State.DONE,
                      io.mtms.domain.model.Steps.State.TODO,
                      5)));

      assertEquals(1, timings.get(0).completions(), "the first go still happened");
      assertEquals(1, timings.get(0).outstanding(), "and it is waiting again now");
    }

    @Test
    @DisplayName("a step never ticked has no answer and is counted as outstanding")
    void neverTicked() {
      List<Timing.StepTiming> timings =
          Timing.perStep(
              List.of(definition()), List.of(list(START)), List.of(entry()), List.of());

      assertNull(timings.get(0).medianDays());
      assertEquals(0, timings.get(0).completions());
      assertEquals(1, timings.get(0).outstanding());
    }

    @Test
    @DisplayName("blocking does not end a period — blocked is still not done")
    void blockedIsNotDone() {
      List<Timing.StepTiming> timings =
          Timing.perStep(
              List.of(definition()),
              List.of(list(START)),
              List.of(entry()),
              // A block is not a done-transition, so it is not even in this list. The period
              // stays open across it and the eventual tick measures the whole wait, which is
              // the honest answer: being blocked is time the work sat there.
              List.of(
                  event(
                      io.mtms.domain.model.Steps.State.BLOCKED,
                      io.mtms.domain.model.Steps.State.DONE,
                      8)));

      assertEquals(8.0, timings.get(0).medianDays());
    }
  }

  @Nested
  @DisplayName("What it refuses to claim")
  class Refusals {

    @Test
    @DisplayName("a column nobody has finished has no answer, not zero")
    void noDataIsNotZero() {
      UUID a = UUID.randomUUID();

      List<Timing.ColumnTiming> timings =
          Timing.perColumn(
              List.of(column("CIQ", 0)),
              List.of(subModule(a, START)),
              // In progress, not done.
              List.of(new Modules.Cell(a, null, "CIQ", "wip", "someone", START)),
              Set.of("done"));

      assertNull(timings.get(0).medianDays(), "zero would read as \"this takes no time\"");
      assertEquals(0, timings.get(0).measured());
      assertEquals(1, timings.get(0).outstanding(), "the one left out has to be visible");
    }

    @Test
    @DisplayName("unfinished work is counted as outstanding, never as fast")
    void outstandingIsReported() {
      UUID fast = UUID.randomUUID();
      List<Modules.SubModule> sixty = new java.util.ArrayList<>();
      sixty.add(subModule(fast, START));
      for (int i = 0; i < 59; i++) {
        sixty.add(subModule(UUID.randomUUID(), START));
      }

      List<Timing.ColumnTiming> timings =
          Timing.perColumn(
              List.of(column("CIQ", 0)), sixty, List.of(done(fast, "CIQ", 1)), Set.of("done"));

      // "1 day" is true and useless without "from 1 of 60" beside it.
      assertEquals(1.0, timings.get(0).medianDays());
      assertEquals(1, timings.get(0).measured());
      assertEquals(59, timings.get(0).outstanding());
    }

    @Test
    @DisplayName("a sub-activity's cells are not counted as the sub-module's")
    void subActivityCellsAreIgnored() {
      UUID a = UUID.randomUUID();

      List<Timing.ColumnTiming> timings =
          Timing.perColumn(
              List.of(column("CIQ", 0)),
              List.of(subModule(a, START)),
              List.of(
                  new Modules.Cell(
                      a, UUID.randomUUID(), "CIQ", "done", "someone", START.plus(Duration.ofDays(9)))),
              Set.of("done"));

      assertNull(
          timings.get(0).medianDays(),
          "counting both grains would measure one piece of work twice, with different answers");
    }

    @Test
    @DisplayName("a status this project does not call done is not counted as done")
    void vocabularyIsThePrjoectsOwn() {
      UUID a = UUID.randomUUID();

      List<Timing.ColumnTiming> timings =
          Timing.perColumn(
              List.of(column("CIQ", 0)),
              List.of(subModule(a, START)),
              List.of(done(a, "CIQ", 5)),
              // This project finishes on "loaded", not "done".
              Set.of("loaded"));

      assertNull(timings.get(0).medianDays());
    }

    @Test
    @DisplayName("a cell older than its sub-module is dropped, not reported as negative")
    void clockSkewIsDropped() {
      UUID a = UUID.randomUUID();

      List<Timing.ColumnTiming> timings =
          Timing.perColumn(
              List.of(column("CIQ", 0)),
              List.of(subModule(a, START)),
              List.of(
                  new Modules.Cell(
                      a, null, "CIQ", "done", "someone", START.minus(Duration.ofDays(3)))),
              Set.of("done"));

      assertNull(timings.get(0).medianDays(), "a negative age is a clock problem, not a finding");
    }
  }
}
