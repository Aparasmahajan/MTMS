package io.mtms.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * The same truth table as {@code lib/shared/__tests__/vocabulary.test.ts}, case for case.
 *
 * <p>That correspondence is deliberate and worth preserving: these two files are the
 * contract between the two implementations. If one is changed without the other, the Java
 * service and the Next.js service will disagree about what a percentage means, and nothing
 * in either build will notice.
 *
 * <p>NOT YET RUN. No JDK on the development machine; see pending.md.
 */
class StatusVocabularyTest {

  @Nested
  @DisplayName("the roll-up rule")
  class RollUp {

    @Test
    @DisplayName("a blank beats everything — one unrecorded subactivity makes the module unrecorded")
    void blankWins() {
      assertEquals("", StatusVocabulary.rollUp(List.of("prod", "", "notloaded")));
    }

    @Test
    @DisplayName("not-done beats in-progress and done")
    void notDoneBeatsTheRest() {
      assertEquals("notloaded", StatusVocabulary.rollUp(List.of("prod", "lab", "notloaded")));
    }

    @Test
    @DisplayName("in-progress beats done")
    void partBeatsDone() {
      assertEquals("lab", StatusVocabulary.rollUp(List.of("prod", "lab", "prod")));
    }

    @Test
    @DisplayName("done only when every subactivity is done")
    void allDone() {
      assertEquals("prod", StatusVocabulary.rollUp(List.of("prod", "prod", "prod")));
    }

    @Test
    @DisplayName("returns a status a subactivity really holds, not a synthetic one")
    void returnsARealStatus() {
      // 'created' and 'loaded' are both done-toned; the answer must be one of the inputs.
      assertEquals("created", StatusVocabulary.rollUp(List.of("created", "loaded")));
    }

    @Test
    @DisplayName("an empty list is blank, not done")
    void emptyIsBlank() {
      // The dangerous bug: vacuous truth making a module with no subactivities read 100%.
      assertEquals("", StatusVocabulary.rollUp(List.of()));
    }
  }

  @Nested
  @DisplayName("readiness")
  class Readiness {

    @Test
    @DisplayName("counts done cells over counted columns")
    void basics() {
      assertEquals(50, StatusVocabulary.readiness(List.of("prod", "notloaded")));
      assertEquals(100, StatusVocabulary.readiness(List.of("prod", "created", "loaded")));
      assertEquals(0, StatusVocabulary.readiness(List.of("notloaded", "", "pending")));
    }

    @Test
    @DisplayName("rounds the way JavaScript does — 7 of 12 is 58, not 59")
    void roundsHalfUp() {
      // The seeded CFX module. If this drifts, every dashboard figure drifts with it.
      assertEquals(58, StatusVocabulary.readiness(List.of(
          "prod", "prod", "prod", "prod", "prod", "prod", "prod",
          "notloaded", "notloaded", "notloaded", "notloaded", "notloaded")));
    }

    @Test
    @DisplayName("in-progress does not count as done")
    void partIsNotDone() {
      assertEquals(0, StatusVocabulary.readiness(List.of("lab", "pending")));
    }

    @Test
    @DisplayName("no counted columns is 0, not a divide by zero")
    void emptyIsZero() {
      assertEquals(0, StatusVocabulary.readiness(List.of()));
    }
  }

  @Nested
  @DisplayName("stage bucketing")
  class Stages {

    @Test
    @DisplayName("100% is the only percentage that reaches the last stage")
    void onlyCompleteReachesTheEnd() {
      assertEquals(5, StatusVocabulary.stageIndex(100, 6));
      assertNotEquals(5, StatusVocabulary.stageIndex(99, 6));
    }

    @Test
    @DisplayName("0% is the first stage")
    void zeroIsFirst() {
      assertEquals(0, StatusVocabulary.stageIndex(0, 6));
    }

    @Test
    @DisplayName("works for two stages and for eight")
    void anyStageCount() {
      assertEquals(0, StatusVocabulary.stageIndex(99, 2));
      assertEquals(1, StatusVocabulary.stageIndex(100, 2));
      assertEquals(7, StatusVocabulary.stageIndex(100, 8));
    }

    @Test
    @DisplayName("a single stage holds everything")
    void oneStage() {
      assertEquals(0, StatusVocabulary.stageIndex(100, 1));
    }
  }

  @Nested
  @DisplayName("advancing a cell")
  class NextStatus {

    private static final List<String> LOAD = List.of("notloaded", "lab", "prod");

    @Test
    @DisplayName("cycles and wraps")
    void cycles() {
      assertEquals("lab", StatusVocabulary.nextStatus("notloaded", LOAD));
      assertEquals("prod", StatusVocabulary.nextStatus("lab", LOAD));
      assertEquals("notloaded", StatusVocabulary.nextStatus("prod", LOAD));
    }

    @Test
    @DisplayName("a blank enters at the first allowed status")
    void blankStartsTheCycle() {
      // indexOf returns -1 for a blank, so (-1 + 1) % n lands on the first entry.
      assertEquals("notloaded", StatusVocabulary.nextStatus("", LOAD));
    }

    @Test
    @DisplayName("an empty subset leaves the value alone")
    void emptyAllowed() {
      assertEquals("prod", StatusVocabulary.nextStatus("prod", List.of()));
    }
  }
}
