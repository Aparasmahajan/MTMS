package io.mtms.domain;

import io.mtms.domain.model.Modules;
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
