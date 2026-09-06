package io.mtms.domain;

import java.util.List;
import java.util.Map;

/**
 * The status vocabulary and the rules derived from it.
 *
 * <p>A direct port of {@code lib/shared/vocabulary.ts}, and the first file of this service on
 * purpose: it is the only code whose behaviour <em>must</em> be identical in both
 * implementations. Everything else may differ in style. If the roll-up or readiness differs
 * here by so much as a rounding mode, the Java service and the Next.js service report
 * different percentages for the same data, and the matrix stops being evidence of anything.
 *
 * <p>{@code StatusVocabularyTest} runs the same truth table as {@code vocabulary.test.ts}, case
 * for case. That correspondence is the point — when a rule changes, both files change together,
 * and the paired tests are what makes a one-sided change fail loudly.
 */
public final class StatusVocabulary {

  private StatusVocabulary() {}

  /**
   * {@code BLANK} is a tone, not the absence of one. A blank means somebody forgot, and the
   * dashboard counts it as a gap — the distinction the whole application exists to make.
   */
  public enum Tone {
    DONE,
    PART,
    NONE,
    BLANK
  }

  public record StatusEntry(String label, Tone tone, String mark) {}

  /**
   * The stored representation of "nothing recorded" — the empty string, never {@code null}.
   *
   * <p>Making it nullable invites a {@code COALESCE} in one query or an {@code
   * orElse("notloaded")} in one mapper, and the difference between "not done" and "nobody
   * recorded it" is exactly what this application exists to show. The column is {@code NOT
   * NULL DEFAULT ''} in the schema for the same reason.
   */
  public static final String BLANK = "";

  private static final Map<String, StatusEntry> VOCABULARY = Map.ofEntries(
      Map.entry("blank", new StatusEntry("Not filled", Tone.BLANK, "?")),
      Map.entry("notcreated", new StatusEntry("Not Created", Tone.NONE, "○")),
      Map.entry("created", new StatusEntry("Created", Tone.DONE, "●")),
      Map.entry("notloaded", new StatusEntry("Not Loaded", Tone.NONE, "○")),
      Map.entry("lab", new StatusEntry("Loaded in lab", Tone.PART, "◐")),
      // Tone PART, like lab: past not-started and short of done. Only DONE counts
      // toward readiness, so adding this status moves no percentage.
      Map.entry("preprod", new StatusEntry("Loaded in preprod", Tone.PART, "◑")),
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
   * Whether a key names a real status. {@code "blank"} is excluded deliberately: it is a tone
   * and a rendering, but it is never a value a column may be configured to allow.
   */
  public static boolean isStatusKey(String key) {
    return key != null && !"blank".equals(key) && VOCABULARY.containsKey(key);
  }

  /** The named subsets the seeded columns draw on. A column may use any subset. */
  public static final Map<String, List<String>> STATUS_SETS = Map.of(
      "create", List.of("notcreated", "created"),
      "load", List.of("notloaded", "lab", "prod"),
      "simple", List.of("notloaded", "loaded"),
      "sign", List.of("pending", "completed"),
      "ritm", List.of("notraised", "raised"));

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
   * <p>{@code Math.round} on a double is half-up, which is what JavaScript's {@code Math.round}
   * does too. {@code RoundingMode.HALF_EVEN} would disagree with the TypeScript at exactly the
   * .5 boundaries — 7/12 is 58.33 and safe, but 8 counted columns with 4 done is not.
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
