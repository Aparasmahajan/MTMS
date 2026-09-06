package io.mtms.domain;

import java.util.List;
import java.util.Map;

/**
 * The status vocabulary and the two derived rules.
 *
 * <p>A direct port of {@code lib/shared/vocabulary.ts}. This is the first file of the Java
 * service on purpose: it is the only code whose behaviour <em>must</em> be identical in both
 * implementations. Everything else can differ in style; if the roll-up or readiness differs
 * here by so much as a rounding mode, the Java service and the Next.js service will report
 * different percentages for the same data, and the matrix stops being evidence of anything.
 *
 * <p>{@code StatusVocabularyTest} runs the same truth table as the TypeScript test, case for
 * case, and that correspondence is the point — when a rule changes, both must change together.
 *
 * <p>NOT YET COMPILED. There is no JDK on the development machine; see pending.md.
 */
public final class StatusVocabulary {

  private StatusVocabulary() {}

  /**
   * {@code blank} is a tone, not the absence of one. A blank means somebody forgot, and the
   * dashboard counts it as a gap — the distinction the whole application exists to make.
   */
  public enum Tone {
    DONE,
    PART,
    NONE,
    BLANK
  }

  public record StatusEntry(String label, Tone tone, String mark) {}

  /** The stored representation of "nothing recorded". Never null — see schema.sql. */
  public static final String BLANK = "";

  private static final Map<String, StatusEntry> VOCABULARY = Map.ofEntries(
      Map.entry("blank", new StatusEntry("Not filled", Tone.BLANK, "?")),
      Map.entry("notcreated", new StatusEntry("Not Created", Tone.NONE, "○")),
      Map.entry("created", new StatusEntry("Created", Tone.DONE, "●")),
      Map.entry("notloaded", new StatusEntry("Not Loaded", Tone.NONE, "○")),
      Map.entry("lab", new StatusEntry("Loaded in lab", Tone.PART, "◐")),
      Map.entry("prod", new StatusEntry("Loaded in prod", Tone.DONE, "●")),
      Map.entry("loaded", new StatusEntry("Loaded", Tone.DONE, "●")),
      Map.entry("pending", new StatusEntry("Pending", Tone.PART, "◐")),
      Map.entry("completed", new StatusEntry("Completed", Tone.DONE, "●")),
      Map.entry("notraised", new StatusEntry("Not raised", Tone.NONE, "○")),
      Map.entry("raised", new StatusEntry("Raised", Tone.DONE, "●")));

  private static final StatusEntry BLANK_ENTRY = VOCABULARY.get("blank");

  public static StatusEntry statusEntry(String key) {
    if (key == null || key.isEmpty()) {
      return BLANK_ENTRY;
    }
    return VOCABULARY.getOrDefault(key, BLANK_ENTRY);
  }

  public static Tone toneOf(String key) {
    return statusEntry(key).tone();
  }

  /**
   * The roll-up rule: a module cell is derived from its subactivities, never stored.
   *
   * <p>Precedence is blank ▸ not-done ▸ in-progress ▸ done. It returns the <em>actual</em>
   * status of the first subactivity at the governing tone, so the label a user sees is one a
   * subactivity really holds rather than a synthetic one.
   */
  public static String rollUp(List<String> subactivityStatuses) {
    if (subactivityStatuses == null || subactivityStatuses.isEmpty()) {
      return BLANK;
    }

    for (Tone governing : List.of(Tone.BLANK, Tone.NONE, Tone.PART)) {
      for (String status : subactivityStatuses) {
        if (toneOf(status) == governing) {
          return governing == Tone.BLANK ? BLANK : status;
        }
      }
    }
    return subactivityStatuses.get(0);
  }

  /**
   * Readiness: done cells ÷ counted columns, as a whole percentage.
   *
   * <p>{@code Math.round} on a double is half-up, which is what JavaScript's {@code
   * Math.round} does too. Using {@code RoundingMode.HALF_EVEN} here would disagree with the
   * TypeScript at exactly the .5 boundaries — 7/12 is 58.33 and safe, but a project with 8
   * counted columns and 4 done is not.
   */
  public static int readiness(List<String> statusesForCountedColumns) {
    if (statusesForCountedColumns == null || statusesForCountedColumns.isEmpty()) {
      return 0;
    }
    long done = statusesForCountedColumns.stream().filter(s -> toneOf(s) == Tone.DONE).count();
    return (int) Math.round((done * 100.0) / statusesForCountedColumns.size());
  }

  /**
   * The stage a module sits in, bucketed from readiness. Never stored: a stage added on the
   * Configure screen re-buckets every module without a migration.
   *
   * <p>100% is the only percentage that reaches the last stage.
   */
  public static int stageIndex(int percent, int stageCount) {
    if (stageCount <= 1) {
      return 0;
    }
    if (percent == 100) {
      return stageCount - 1;
    }
    return Math.min(stageCount - 2, (int) Math.floor(percent / (100.0 / (stageCount - 1))));
  }

  /** Advances through a column's configured subset, wrapping. A blank starts the cycle. */
  public static String nextStatus(String current, List<String> allowed) {
    if (allowed == null || allowed.isEmpty()) {
      return current;
    }
    int index = allowed.indexOf(current == null ? BLANK : current);
    return allowed.get((index + 1) % allowed.size());
  }
}
