package io.mtms.domain;

import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Steps;
import io.mtms.domain.model.Projects;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * How long work actually takes, measured from what is already stored.
 *
 * <p><strong>The point of this is that nobody fills anything in.</strong> Every cell carries the
 * moment it last changed and every sub-module carries the moment it was created, so the elapsed
 * time between them is a fact the application has been recording since the first tick. Most
 * tools cannot answer "how long does CIQ take" because they rely on estimates that people stop
 * updating by the second sprint. This answers it from the ticks themselves, and it has answers
 * for work that finished months ago.
 *
 * <p>Pure, like {@link StepGate} and {@link PromotionGate}: given rows, returns numbers. No clock
 * of its own beyond the one passed in, no repository, so the whole thing is testable against
 * literals.
 *
 * <h2>What is being measured, precisely</h2>
 *
 * <p>For one column, over every sub-module where that column is <em>done</em>: the days from the
 * sub-module being created to that cell's last change. That is a <strong>lead time</strong> — the
 * total from the work appearing to that deliverable being finished — not the time spent working
 * on it. The difference between one column's lead time and the previous column's is the useful
 * number: it is roughly how long the work sat at that stage, and it is reported as {@code
 * addedDays}.
 *
 * <h2>Three limitations, stated rather than buried</h2>
 *
 * <ul>
 *   <li><strong>A cell keeps only its last change.</strong> Re-ticking something a month later
 *       moves its timestamp, so a column that was corrected reads as having taken longer. The
 *       step events are an append-only history and do not have this problem; the cells are a
 *       current-state table and never had one.
 *   <li><strong>Creation is not the same as starting.</strong> A sub-module added to the tracker
 *       in January and genuinely begun in March reads as five months of lead time. That is
 *       honest about the tracker and misleading about the team, and it is why the median is
 *       reported next to the mean — one sub-module left sitting drags the mean and barely moves
 *       the median.
 *   <li><strong>Only finished work counts.</strong> Anything still in progress is excluded
 *       entirely, so a column where everything is stuck reports nothing rather than reporting
 *       zero. {@code outstanding} says how many were left out, because "3 days, from 2 of 60" is
 *       a very different statement from "3 days".
 * </ul>
 */
public final class Timing {

  private Timing() {}

  /**
   * One column's timings.
   *
   * @param medianDays the middle value. The headline number, because one abandoned sub-module
   *     moves a mean a long way and a median hardly at all.
   * @param meanDays the average, kept beside the median deliberately: when the two disagree
   *     sharply, the spread is the finding.
   * @param addedDays how much longer this column takes than the one before it in the configured
   *     order — the closest thing to "time spent at this stage". Null for the first column, which
   *     has nothing to be measured against.
   * @param measured how many finished sub-modules these numbers are computed from.
   * @param outstanding how many are not finished here, and so are not in the numbers at all.
   */
  public record ColumnTiming(
      String columnKey,
      String label,
      Double medianDays,
      Double meanDays,
      Double addedDays,
      int measured,
      int outstanding) {}

  /**
   * Computes a timing per column, in the configured column order.
   *
   * @param columns the active columns, in display order. Off columns are excluded by the caller,
   *     because a switched-off environment is not part of the process any more and its old
   *     timings would describe a process nobody follows.
   * @param doneStatuses which statuses count as finished for this project. Passed in rather than
   *     assumed: a project defines its own vocabulary, and hard-coding "done" here would silently
   *     report nothing for a team that calls it something else.
   */
  public static List<ColumnTiming> perColumn(
      List<Projects.DeliverableColumn> columns,
      List<Modules.SubModule> subModules,
      List<Modules.Cell> cells,
      java.util.Set<String> doneStatuses) {

    Map<UUID, Instant> createdAt = new HashMap<>();
    for (Modules.SubModule subModule : subModules) {
      createdAt.put(subModule.id(), subModule.createdAt());
    }

    // Only the sub-module's own row. A sub-activity's cells belong to a finer grain and mixing
    // the two would count one piece of work several times, with different answers each.
    Map<String, List<Modules.Cell>> byColumn = new HashMap<>();
    for (Modules.Cell cell : cells) {
      if (cell.isSubModuleRow()) {
        byColumn.computeIfAbsent(cell.columnKey(), key -> new ArrayList<>()).add(cell);
      }
    }

    List<ColumnTiming> timings = new ArrayList<>();
    Double previousMedian = null;

    for (Projects.DeliverableColumn column : columns) {
      List<Double> days = new ArrayList<>();

      for (Modules.Cell cell : byColumn.getOrDefault(column.key(), List.of())) {
        Instant created = createdAt.get(cell.subModuleId());
        if (created == null || cell.changedAt() == null || !doneStatuses.contains(cell.status())) {
          continue;
        }
        // Negative would mean a cell changed before its sub-module existed, which is a clock
        // problem rather than a measurement. Dropped rather than reported as a negative age.
        double elapsed = days(created, cell.changedAt());
        if (elapsed >= 0) {
          days.add(elapsed);
        }
      }

      int outstanding = subModules.size() - days.size();
      Double median = median(days);
      Double mean = mean(days);

      Double added = null;
      if (median != null && previousMedian != null) {
        // Can legitimately be negative: a column finished before the one to its left, which
        // happens when the order on the screen is a reading order rather than a sequence. Shown
        // as it is rather than clamped, because clamping would hide exactly that.
        added = round(median - previousMedian);
      }

      timings.add(
          new ColumnTiming(
              column.key(), column.label(), median, mean, added, days.size(), outstanding));

      if (median != null) {
        previousMedian = median;
      }
    }

    return timings;
  }

  /**
   * One step's timings, across every checklist it appears on.
   *
   * @param medianDays the middle time from a step becoming outstanding to it being ticked done.
   * @param completions how many times it was finished — not how many steps there are. A step
   *     ticked, un-ticked and ticked again counts twice, because it genuinely took two goes and
   *     reporting it once would hide the rework that is usually the reason somebody asked.
   * @param outstanding how many are attached and not currently done.
   */
  public record StepTiming(
      UUID definitionId,
      String name,
      Double medianDays,
      Double meanDays,
      int completions,
      int outstanding) {}

  /**
   * How long each step takes, from the append-only event history.
   *
   * <p><strong>This is the accurate half.</strong> {@link #perColumn} reads the cells, which keep
   * only their last change, so a deliverable corrected a month later reads as having taken a
   * month. Step events are never rewritten, so this pairs each "became outstanding" with the
   * "ticked done" that ended it and gets the re-tick case right: a step ticked, un-ticked and
   * ticked again produced <em>two</em> durations, and a naive first-to-last would report the
   * whole calendar span — wildly wrong exactly on the work that went badly, which is the work
   * anybody is asking about.
   *
   * <p>A period opens when the checklist is attached, and again on every transition out of done.
   * It closes on the transition into done. Anything still open at the end is not a duration and
   * is counted as outstanding rather than as fast.
   *
   * @param transitions every event into or out of {@code done}, ascending by time. Ascending is
   *     required, not a preference: the walk below treats order as the truth about what happened.
   */
  public static List<StepTiming> perStep(
      List<Steps.Definition> definitions,
      List<Steps.StepList> lists,
      List<Steps.Entry> entries,
      List<Steps.Event> transitions) {

    Map<UUID, Instant> attachedAt = new HashMap<>();
    Map<UUID, Instant> listCreated = new HashMap<>();
    for (Steps.StepList list : lists) {
      listCreated.put(list.id(), list.createdAt());
    }

    Map<UUID, UUID> definitionOfEntry = new HashMap<>();
    for (Steps.Entry entry : entries) {
      definitionOfEntry.put(entry.id(), entry.definitionId());
      // When the checklist was attached is when this step started being outstanding. There is no
      // per-entry timestamp, and the list's is the honest stand-in: the entries are written in
      // the same transaction as the list they belong to.
      Instant created = listCreated.get(entry.stepListId());
      if (created != null) {
        attachedAt.put(entry.id(), created);
      }
    }

    Map<UUID, List<Double>> daysByDefinition = new HashMap<>();
    Map<UUID, Boolean> doneNow = new HashMap<>();
    Map<UUID, Instant> openedAt = new HashMap<>(attachedAt);

    for (Steps.Event event : transitions) {
      UUID definitionId = definitionOfEntry.get(event.entryId());
      if (definitionId == null) {
        // An event for an entry that has since been deleted. Its history outlived its
        // configuration, which is by design; it has nothing to be attributed to.
        continue;
      }

      boolean into = event.to() == Steps.State.DONE;
      boolean outOf = event.from() == Steps.State.DONE && !into;

      if (into) {
        Instant opened = openedAt.get(event.entryId());
        if (opened != null && event.at() != null && !event.at().isBefore(opened)) {
          daysByDefinition
              .computeIfAbsent(definitionId, key -> new ArrayList<>())
              .add(days(opened, event.at()));
        }
        openedAt.remove(event.entryId());
        doneNow.put(event.entryId(), true);
      } else if (outOf) {
        // Un-ticked. A new period starts here, and the one that just ended has already been
        // counted — which is what makes two goes read as two durations.
        openedAt.put(event.entryId(), event.at());
        doneNow.put(event.entryId(), false);
      }
    }

    List<StepTiming> timings = new ArrayList<>();
    for (Steps.Definition definition : definitions) {
      List<Double> days = daysByDefinition.getOrDefault(definition.id(), List.of());

      int outstanding = 0;
      for (Map.Entry<UUID, UUID> entry : definitionOfEntry.entrySet()) {
        if (entry.getValue().equals(definition.id())
            && !Boolean.TRUE.equals(doneNow.get(entry.getKey()))) {
          outstanding++;
        }
      }

      timings.add(
          new StepTiming(
              definition.id(),
              definition.name(),
              median(days),
              mean(days),
              days.size(),
              outstanding));
    }

    // Slowest first. A list of steps in configuration order buries the finding; the question
    // being asked is which step the work sits at.
    timings.sort(
        Comparator.comparing(
            StepTiming::medianDays, Comparator.nullsLast(Comparator.reverseOrder())));
    return timings;
  }

  private static double days(Instant from, Instant to) {
    return round(Duration.between(from, to).toHours() / 24.0);
  }

  /** Null for no data, so the caller renders "not enough yet" rather than a confident zero. */
  private static Double median(List<Double> values) {
    if (values.isEmpty()) {
      return null;
    }
    List<Double> sorted = new ArrayList<>(values);
    sorted.sort(Comparator.naturalOrder());
    int middle = sorted.size() / 2;
    return sorted.size() % 2 == 1
        ? round(sorted.get(middle))
        : round((sorted.get(middle - 1) + sorted.get(middle)) / 2.0);
  }

  private static Double mean(List<Double> values) {
    if (values.isEmpty()) {
      return null;
    }
    double total = 0;
    for (double value : values) {
      total += value;
    }
    return round(total / values.size());
  }

  /** One decimal. Hours of precision on a figure measured in weeks is false confidence. */
  private static double round(double value) {
    return Math.round(value * 10.0) / 10.0;
  }
}
