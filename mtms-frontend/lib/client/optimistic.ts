import { BLANK, nextStatus, readiness, rollUp, stageIndex, toneOf } from '@/lib/shared/vocabulary';
import { columnDisplayLabel } from '@/lib/shared/views';
import type { CellView, ColumnView, SubModuleView, Snapshot } from '@/lib/shared/views';

/**
 * The optimistic mirror of `advanceCell`.
 *
 * It recomputes the affected module with the same pure functions the server uses, so
 * the value shown before the response lands is the value the server will send back.
 * If the server refuses, `TrackerProvider` rolls this back — nothing here decides
 * whether the change is allowed.
 */
export function optimisticAdvance(
  snapshot: Snapshot,
  subModuleId: string,
  subActivityId: string | null,
  columnKey: string,
  actor: string,
): Snapshot {
  const column = snapshot.config.columns.find((candidate) => candidate.key === columnKey);
  if (!column) return snapshot;

  const subModules = snapshot.sub_modules.map((subModule) => {
    if (subModule.id !== subModuleId) return subModule;

    const at = new Date().toISOString();

    const subActivities = subModule.sub_activities.map((subActivity) => {
      if (subActivity.id !== subActivityId) return subActivity;
      const cells = subActivity.cells.map((cell) =>
        cell.column_key === columnKey
          ? {
              ...cell,
              status: nextStatus(cell.status, column.allowed),
              changed_by: actor,
              changed_at: at,
            }
          : cell,
      );
      return { ...subActivity, cells, readiness: readinessOf(cells, snapshot.config.columns) };
    });

    const cells: CellView[] =
      subActivityId === null
        ? subModule.cells.map((cell) =>
            cell.column_key === columnKey
              ? {
                  ...cell,
                  status: nextStatus(cell.status, column.allowed),
                  changed_by: actor,
                  changed_at: at,
                }
              : cell,
          )
        : subModule.cells.map((cell) => ({
            ...cell,
            status: rollUp(
              subActivities.map(
                (subActivity) =>
                  subActivity.cells.find((entry) => entry.column_key === cell.column_key)?.status ??
                  BLANK,
              ),
            ),
          }));

    return withDerived(
      { ...subModule, cells, sub_activities: subActivities },
      snapshot.config.columns,
      snapshot.config.stages.length,
    );
  });

  return { ...snapshot, sub_modules: subModules };
}

/**
 * The columns that are in the maths. A column behind a switched-off environment is still
 * in the snapshot, cells and all, and must not be counted — the same filter the server
 * applies in `buildSnapshot`, or the optimistic percentage would jump and then snap back.
 */
function activeColumns(columns: readonly ColumnView[]): ColumnView[] {
  return columns.filter((column) => column.active);
}

function readinessOf(cells: readonly CellView[], columns: readonly ColumnView[]): number {
  const counted = activeColumns(columns).filter((column) => column.counts);
  return readiness(
    counted.map((column) => cells.find((cell) => cell.column_key === column.key)?.status ?? BLANK),
  );
}

/** Recomputes everything derived from a module's cells: readiness, stage, missing, blanks. */
export function withDerived(
  subModule: SubModuleView,
  columns: readonly ColumnView[],
  stageCount: number,
): SubModuleView {
  const statusFor = (key: string): string =>
    subModule.cells.find((cell) => cell.column_key === key)?.status ?? BLANK;

  const active = activeColumns(columns);
  const counted = active.filter((column) => column.counts);
  const percent = readiness(counted.map((column) => statusFor(column.key)));

  return {
    ...subModule,
    readiness: percent,
    stage_index: stageIndex(percent, stageCount),
    missing: counted
      .filter((column) => toneOf(statusFor(column.key)) !== 'done')
      .map(columnDisplayLabel),
    blank_count: active.filter((column) => statusFor(column.key) === BLANK).length,
  };
}
