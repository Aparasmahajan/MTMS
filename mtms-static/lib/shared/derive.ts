import { rollUp, toneOf } from './vocabulary';
import type { DeliverableColumn, StepState } from './domain';
import {
  columnDisplayLabel,
  type ColumnTimingView,
  type ModuleView,
  type StepTimingView,
} from './views';

/**
 * The derived figures that used to be computed only inside `buildSnapshot`.
 *
 * Pure, and free of anything Node-only, so the static demo's reducer (`lib/demo/runtime.ts`)
 * can recompute them after every mutation with the same code the server projection uses.
 * Before this they were computed once at build time and then frozen: tick a cell in the demo
 * and the module figures and both timing panels went on reporting the seed.
 *
 * Every function here reads the *view* shapes, not the store, because a view is all the
 * demo has. The server builds the views first and then calls these over them, so the two
 * cannot disagree about a number.
 */

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** One decimal. Hours of precision on a figure measured in weeks is false confidence. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function daysBetween(from: string, to: string): number {
  return round1((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** Null for no data, so the caller renders "not enough yet" rather than a confident zero. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  return sorted.length % 2 === 1
    ? round1(upper)
    : round1(((sorted[middle - 1] as number) + upper) / 2);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return round1(values.reduce((total, value) => total + value, 0) / values.length);
}

// ---------------------------------------------------------------------------
// Column timing
// ---------------------------------------------------------------------------

interface TimedCell {
  column_key: string;
  status: string;
  changed_at: string | null;
}

/** What `columnTimings` needs of a sub-module — `SubModuleView` satisfies it. */
export interface TimingSubject {
  /** Absent on a snapshot saved before sub-modules carried it; such a row is not measured. */
  created_at?: string | null;
  cells: readonly TimedCell[];
  sub_activities: readonly { cells: readonly TimedCell[] }[];
}

/**
 * When one sub-module finished one column, or null if it has not (or it cannot be told).
 *
 * A sub-module with sub-activities has no stored cell of its own — its row is the roll-up —
 * so it is finished when the roll-up is done, which is when the *last* sub-activity got there.
 * Reading only the module row, as this used to, counted every such sub-module as outstanding
 * forever: its own row never changes, because it is never written.
 */
function finishedAt(subject: TimingSubject, columnKey: string): string | null {
  if (subject.sub_activities.length === 0) {
    const cell = subject.cells.find((candidate) => candidate.column_key === columnKey);
    if (!cell || !cell.changed_at || toneOf(cell.status) !== 'done') return null;
    return cell.changed_at;
  }

  const cells = subject.sub_activities.map((sub) =>
    sub.cells.find((candidate) => candidate.column_key === columnKey),
  );
  if (toneOf(rollUp(cells.map((cell) => cell?.status ?? ''))) !== 'done') return null;

  let latest: string | null = null;
  for (const cell of cells) {
    // A done cell with no stamp: when it finished is unknown, so the whole row is.
    if (!cell?.changed_at) return null;
    if (latest === null || cell.changed_at > latest) latest = cell.changed_at;
  }
  return latest;
}

/**
 * Days from a sub-module being created to each column being done.
 *
 * "Done" is read from the project's own vocabulary rather than assumed: a project defines
 * which statuses mean finished, and hard-coding one word here would silently report nothing
 * for a team whose column says "Loaded in prod".
 *
 * Labelled with `columnDisplayLabel`, not the bare label: a deliverable tracked per
 * environment has three columns all labelled LAB / PRE / PROD, and on a panel with no group
 * header above them three rows called "PROD" cannot be told apart.
 */
export function columnTimings(
  activeColumns: readonly DeliverableColumn[],
  subjects: readonly TimingSubject[],
): ColumnTimingView[] {
  const timings: ColumnTimingView[] = [];
  let previousMedian: number | null = null;

  for (const column of activeColumns) {
    const days: number[] = [];

    for (const subject of subjects) {
      if (!subject.created_at) continue;
      const finished = finishedAt(subject, column.key);
      if (!finished) continue;
      // Negative means a cell changed before its sub-module existed — a clock problem
      // rather than a measurement, so it is dropped rather than reported as a negative age.
      const elapsed = daysBetween(subject.created_at, finished);
      if (elapsed >= 0) days.push(elapsed);
    }

    const middle = median(days);
    // Can legitimately be negative: a column finished before the one to its left. Shown as
    // it is rather than clamped, because clamping would hide exactly that.
    const added = middle !== null && previousMedian !== null ? round1(middle - previousMedian) : null;

    timings.push({
      column_key: column.key,
      label: columnDisplayLabel(column),
      median_days: middle,
      mean_days: mean(days),
      added_days: added,
      measured: days.length,
      // Anything unfinished is excluded rather than counted as instant, and the count says
      // so: "4 days, from 2 of 60" is a very different statement from "4 days".
      outstanding: subjects.length - days.length,
    });

    if (middle !== null) previousMedian = middle;
  }

  return timings;
}

// ---------------------------------------------------------------------------
// Step timing
// ---------------------------------------------------------------------------

/** What `stepTimings` needs of a checklist — `StepListView` satisfies it. */
export interface TimedStepList {
  created_at?: string | null;
  entries: readonly {
    definition_id: string;
    name: string;
    history: readonly { from: string; to: string; at: string }[];
  }[];
}

/**
 * How long each step takes, from the append-only history.
 *
 * Measured from the moment a step became outstanding — the checklist being attached, or the
 * last un-tick — to the tick that followed. A step ticked twice is two durations, which is
 * the whole reason this reads events rather than the current state.
 */
export function stepTimings(lists: readonly TimedStepList[]): StepTimingView[] {
  const perDefinition = new Map<string, { name: string; days: number[]; outstanding: number }>();

  for (const list of lists) {
    for (const entry of list.entries) {
      const bucket = perDefinition.get(entry.definition_id) ?? {
        name: entry.name,
        days: [],
        outstanding: 0,
      };

      const events = [...entry.history].sort((a, b) => a.at.localeCompare(b.at));

      // Outstanding from the moment the checklist was attached, not from the first event —
      // otherwise a step nobody has touched contributes nothing and the wait is invisible.
      let since: string | null = list.created_at ?? events[0]?.at ?? null;
      let waiting = true;

      for (const event of events) {
        if (event.to === 'done' && waiting) {
          if (since !== null) {
            const elapsed = daysBetween(since, event.at);
            if (elapsed >= 0) bucket.days.push(elapsed);
          }
          waiting = false;
          since = null;
        } else if (event.from === 'done' && event.to !== 'done') {
          // Un-ticked: it is waiting again, and the clock restarts from here.
          waiting = true;
          since = event.at;
        }
      }

      if (waiting) bucket.outstanding += 1;
      perDefinition.set(entry.definition_id, bucket);
    }
  }

  return [...perDefinition.entries()]
    .map(([definitionId, bucket]) => ({
      definition_id: definitionId,
      name: bucket.name,
      median_days: median(bucket.days),
      mean_days: mean(bucket.days),
      completions: bucket.days.length,
      outstanding: bucket.outstanding,
    }))
    // Slowest first: the point of the panel is which step is the bottleneck.
    .sort((a, b) => (b.median_days ?? -1) - (a.median_days ?? -1));
}

// ---------------------------------------------------------------------------
// Module figures
// ---------------------------------------------------------------------------

/**
 * The figures a module shows, counted from its live sub-modules.
 *
 * Computed rather than stored, for the same reason the platform console derives its own: a
 * stored count is a second copy that drifts.
 */
export function moduleFigures(
  name: string,
  subModules: readonly { module_name: string; readiness: number }[],
): Pick<ModuleView, 'sub_module_count' | 'in_prod' | 'readiness'> {
  const mine = subModules.filter((subModule) => subModule.module_name === name);
  return {
    sub_module_count: mine.length,
    // Every counted deliverable done — the matrix's own definition of finished.
    in_prod: mine.filter((subModule) => subModule.readiness === 100).length,
    readiness:
      mine.length === 0
        ? 0
        : Math.round(mine.reduce((total, subModule) => total + subModule.readiness, 0) / mine.length),
  };
}

/**
 * The module records, reconciled against the editable list of names and re-counted.
 *
 * A name with no record yet keeps a derived `pending:` id, exactly as `buildSnapshot` gives
 * it, so the Configure screen and the matrix cannot disagree about which modules exist.
 */
export function reconcileModules(
  existing: readonly ModuleView[],
  moduleNames: readonly string[],
  subModules: readonly { module_name: string; readiness: number }[],
): ModuleView[] {
  return moduleNames.map((name, index) => {
    const record = existing.find((candidate) => candidate.name === name);
    return {
      id: record?.id ?? `pending:${name}`,
      name,
      description: record?.description ?? '',
      order_index: record?.order_index ?? index,
      owners: record?.owners ?? [],
      threads: record?.threads ?? [],
      ...moduleFigures(name, subModules),
    };
  });
}

// ---------------------------------------------------------------------------
// The step gate
// ---------------------------------------------------------------------------

export interface StepGate {
  canTick: boolean;
  isOverrideForMe: boolean;
  lockedReason: string;
}

/**
 * Whether this reader may tick one entry, and why not when they may not.
 *
 * The order of the checks is the message: the list's own order first, then who is allowed.
 * Each refusal names the thing standing in the way, because "not allowed" sends somebody to
 * ask an administrator about a permission when the real answer is that step 1 is not done.
 *
 * Shared by the server projection and the static demo, so switching the demo's role re-gates
 * every checklist with exactly the rule the server applies.
 */
export function stepGate(input: {
  enforceOrder: boolean;
  /** The entries before this one, in list order. */
  earlier: readonly { name: string | undefined; state: StepState }[];
  /** The roles the step's definition names, as ids. Empty means none that still exists. */
  roleIds: readonly string[];
  /** Their names, for the message. */
  allowedNames: readonly string[];
  /** The roles this reader holds here, as ids. */
  myRoleIds: readonly string[];
  /** Holds `project.config` — may tick anything, recorded as an override. */
  canConfigure: boolean;
}): StepGate {
  if (input.enforceOrder) {
    const blocking = input.earlier.find((candidate) => candidate.state !== 'done');
    if (blocking) {
      return {
        canTick: false,
        isOverrideForMe: false,
        lockedReason: `This checklist runs in order, and "${blocking.name ?? 'an earlier step'}" is not done yet.`,
      };
    }
  }

  const { canConfigure } = input;

  if (input.roleIds.length === 0) {
    // A step whose last allowed role was deleted must not quietly become one anybody may
    // tick. That is the opposite of what gating meant, so it closes rather than opens.
    return {
      canTick: canConfigure,
      isOverrideForMe: canConfigure,
      lockedReason: canConfigure
        ? 'This step names no role that still exists. Ticking it will be recorded as an override.'
        : 'This step names no role that still exists, so nobody can tick it until an admin picks one.',
    };
  }

  if (input.myRoleIds.some((roleId) => input.roleIds.includes(roleId))) {
    return { canTick: true, isOverrideForMe: false, lockedReason: '' };
  }

  const allowed = input.allowedNames.join(' or ');
  return {
    canTick: canConfigure,
    isOverrideForMe: canConfigure,
    lockedReason: canConfigure
      ? `Only ${allowed} may tick this. You can, as an override, and it is recorded as one.`
      : `Only ${allowed} may tick this.`,
  };
}
