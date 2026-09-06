import type { DeliverableColumn } from './domain';
import { toneOf } from './vocabulary';
import type { DriftRowView, ModuleView, PromotionGateView } from './views';

/**
 * The promotion gate.
 *
 * Shared rather than server-only because it is derived, and because the static demo has
 * to recompute it when a client edits a cell — a gate that did not move would teach the
 * wrong thing about how the screen works. The server still recomputes it before it will
 * record a promotion; this is not the enforcement point.
 *
 * All five checks are computed. A check that cannot be evaluated reads as **closed**, not
 * as unknown: promotion copies hashes onto production, and "we could not tell" is not a
 * reason to let it through.
 */
export function promotionGate(
  columns: readonly DeliverableColumn[],
  modules: readonly ModuleView[],
  rows: readonly DriftRowView[],
): PromotionGateView {
  const lowest = modules.length ? Math.min(...modules.map((module) => module.readiness)) : 0;
  const mismatches = rows.filter(
    (row) => row.verdict === 'Prod behind' || row.verdict === 'Patched in place',
  );
  const unverified = rows.filter(
    (row) => row.verdict === 'Never verified' || row.verdict === 'Not deployed',
  );

  /**
   * The two sign-off columns the FNI chain already turns on, looked up by key. Same
   * documented exception as the FNI gate itself — a project that drops either column
   * gets a check that says "not configured" rather than one that silently passes.
   */
  const signOff = (columnKey: string) => {
    const column = columns.find((candidate) => candidate.key === columnKey);
    if (!column) return { present: false, outstanding: 0 };
    const outstanding = modules.filter((module) => {
      const cell = module.cells.find((candidate) => candidate.column_key === columnKey);
      return !cell || toneOf(cell.status) !== 'done';
    }).length;
    return { present: true, outstanding };
  };

  const fni = signOff('fni');
  const access = signOff('access');

  const checks = [
    {
      text: 'Every counted deliverable is Loaded in prod',
      detail: modules.length ? `lowest module ${lowest}%` : 'no modules',
      passed: modules.length > 0 && lowest === 100,
    },
    {
      text: 'Preprod hash matches the prod hash',
      detail: mismatches.length
        ? `${mismatches.length} ${mismatches.length === 1 ? 'mismatch' : 'mismatches'}`
        : 'all in step',
      passed: mismatches.length === 0,
    },
    {
      text: 'Every deliverable has a verified prod hash',
      detail: unverified.length ? `${unverified.length} unverified` : 'all reported',
      passed: rows.length > 0 && unverified.length === 0,
    },
    {
      text: fni.present ? 'FNI final submission complete' : 'FNI column not configured',
      detail: fni.present ? (fni.outstanding ? `${fni.outstanding} outstanding` : 'complete') : 'not configured',
      passed: fni.present && fni.outstanding === 0,
    },
    {
      text: access.present ? 'Node access granted' : 'Access column not configured',
      detail: access.present
        ? access.outstanding
          ? `${access.outstanding} outstanding`
          : 'granted'
        : 'not configured',
      passed: access.present && access.outstanding === 0,
    },
  ];

  const blocked = checks.filter((check) => !check.passed).length;

  return {
    checks,
    blocked,
    can_promote: blocked === 0,
    label:
      blocked === 0
        ? 'Promote preprod → prod'
        : `Promote — blocked by ${blocked} ${blocked === 1 ? 'gate' : 'gates'}`,
  };
}
