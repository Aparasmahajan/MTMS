import { createHash, randomUUID } from 'node:crypto';
import {
  DRIFT_ENVIRONMENTS,
  type DriftEnvironment,
  type DriftObservation,
  type DriftVerdict,
} from '../shared/domain';
import { toneOf } from '../shared/vocabulary';
import type { DriftRowView, DriftWarningView, ModuleView } from '../shared/views';
import { promotionGate as computeGate } from '../shared/promotion';
import type { StoreData } from './store';

/**
 * The drift engine.
 *
 * "Loaded in prod" is only true if the bytes on prod are the ones that passed preprod.
 * Everything here is derived from `drift_observations` — hashes reported per file, per
 * environment, by an agent. Nothing is stored pre-computed, so a fresh report changes
 * every verdict, warning and gate on the next read.
 *
 * The rules encode failures that have already cost this project real days. Each one is
 * commented with what it caught.
 */

/** How long before a report is old enough that "we do not know" is the honest answer. */
const STALE_REPORT_DAYS = 7;

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

/** Six characters is what fits the column; the full hash stays in the title. */
export function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 6) : 'unknown';
}

/**
 * A deliverable can be more than one file. Its hash on an environment is then the hash of
 * the sorted `path\0hash` pairs — so adding, removing or changing any file in the set
 * changes the deliverable's identity, and the order files were reported in does not.
 */
export function compositeHash(observations: readonly DriftObservation[]): string | null {
  if (observations.length === 0) return null;
  if (observations.length === 1) return observations[0]!.content_hash;

  const digest = createHash('sha256');
  for (const observation of [...observations].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    digest.update(`${observation.path}\0${observation.content_hash}\n`);
  }
  return digest.digest('hex');
}

interface Resolved {
  columnKey: string;
  layer: string;
  scope: string;
  cadence: string;
  label: string;
  byEnvironment: Record<DriftEnvironment, string | null>;
  observations: Record<DriftEnvironment, DriftObservation[]>;
}

function resolve(store: StoreData, projectId: string): Resolved[] {
  const deliverables = store.drift_deliverables.filter((entry) => entry.project_id === projectId);
  const columns = store.columns.filter((column) => column.project_id === projectId);

  return deliverables.map((deliverable) => {
    const mine = store.drift_observations.filter(
      (observation) =>
        observation.project_id === projectId && observation.column_key === deliverable.column_key,
    );

    const observations = {} as Record<DriftEnvironment, DriftObservation[]>;
    const byEnvironment = {} as Record<DriftEnvironment, string | null>;
    for (const environment of DRIFT_ENVIRONMENTS) {
      const rows = mine.filter((observation) => observation.environment === environment);
      observations[environment] = rows;
      byEnvironment[environment] = compositeHash(rows);
    }

    return {
      columnKey: deliverable.column_key,
      layer: deliverable.layer,
      scope: deliverable.scope,
      cadence: deliverable.cadence,
      label:
        columns.find((column) => column.key === deliverable.column_key)?.label ??
        deliverable.column_key.toUpperCase(),
      byEnvironment,
      observations,
    };
  });
}

/**
 * The verdict for one deliverable.
 *
 * `Patched in place` is the one worth reading twice: the servers agree with each other and
 * disagree with the repo, which means somebody edited the deployed copy. It is a different
 * fault from `Prod behind` and needs a different fix, so it gets its own verdict.
 */
export function verdictFor(hashes: Record<DriftEnvironment, string | null>): DriftVerdict {
  const { repo, lab, preprod, prod } = hashes;

  // In the repo and on no server at all. Distinct from "never verified on prod": this one
  // has not been deployed anywhere, which is usually a missing `.packinglist` entry.
  if (repo && !lab && !preprod && !prod) return 'Not deployed';
  if (!prod) return 'Never verified';
  if (preprod && preprod !== prod) return 'Prod behind';
  if (repo && preprod && repo !== preprod && preprod === prod) return 'Patched in place';
  if (repo && repo !== prod) return 'Patched in place';
  return 'In step';
}

export function driftRows(store: StoreData, projectId: string): DriftRowView[] {
  return resolve(store, projectId).map((entry) => ({
    id: `${projectId}:${entry.columnKey}`,
    column_key: entry.columnKey,
    layer: entry.label,
    scope: entry.scope,
    cadence: entry.cadence,
    code_layer: entry.layer,
    repo: shortHash(entry.byEnvironment.repo),
    lab: shortHash(entry.byEnvironment.lab),
    preprod: shortHash(entry.byEnvironment.preprod),
    prod: shortHash(entry.byEnvironment.prod),
    full_hashes: {
      repo: entry.byEnvironment.repo,
      lab: entry.byEnvironment.lab,
      preprod: entry.byEnvironment.preprod,
      prod: entry.byEnvironment.prod,
    },
    paths: [...new Set(Object.values(entry.observations).flat().map((row) => row.path))],
    verdict: verdictFor(entry.byEnvironment),
  }));
}

/**
 * Warnings, derived rather than written down. Every rule below corresponds to something
 * that has already gone wrong on this system.
 */
export function driftWarnings(
  store: StoreData,
  projectId: string,
  modules: readonly ModuleView[],
): DriftWarningView[] {
  const warnings: DriftWarningView[] = [];
  const entries = resolve(store, projectId);

  for (const entry of entries) {
    const { repo, lab, preprod, prod } = entry.byEnvironment;

    // §7.1 / §7.3 — nobody has ever reported this from prod, so "loaded in prod" is a
    // claim rather than a fact. Worse when the deliverable is shared between flavours.
    if (!prod) {
      const shared = entry.scope === 'shared';
      warnings.push({
        id: `never_verified:${entry.columnKey}`,
        kind: 'never_verified',
        severity: shared ? 'High' : 'Med',
        text: shared
          ? `${entry.label} is shared, and prod has no recorded hash for it — a change there lands on every flavour unverified.`
          : `${entry.label} has no recorded hash on prod, so nothing can confirm what is running there.`,
        where: `prod · ${entry.observations.repo[0]?.path ?? entry.columnKey}`,
      });
    }

    // §7.3 — run 511's five false errors: the server's script was an older build than
    // the one preprod verified, and nothing in the run output said so.
    if (prod && preprod && preprod !== prod) {
      warnings.push({
        id: `prod_behind:${entry.columnKey}`,
        kind: 'prod_behind',
        severity: 'High',
        text: `${entry.label} on prod is not the build preprod verified. A run on prod is not executing the code that was tested.`,
        where: `prod · ${shortHash(prod)} · preprod has ${shortHash(preprod)}`,
      });
    }

    // Servers agree with each other but not the repo — edited in place.
    if (repo && preprod && prod && repo !== preprod && preprod === prod) {
      warnings.push({
        id: `patched_in_place:${entry.columnKey}`,
        kind: 'patched_in_place',
        severity: 'High',
        text: `${entry.label} on preprod and prod does not match the repo. It was edited in place, so the next deploy will silently revert it.`,
        where: `preprod, prod · ${shortHash(preprod)} · repo has ${shortHash(repo)}`,
      });
    }

    // §7.2 — SnakeYAML binds against the compiled bean. A class older than its source is
    // how "Cannot create property 'category'" became a day of blaming YAML indentation.
    //
    // Grouped by file: the same stale jar copied to four environments is one fault to fix,
    // not four, and four identical sentences is how a warnings list stops being read.
    const staleOn = new Map<string, DriftEnvironment[]>();
    const notListedOn = new Map<string, DriftEnvironment[]>();

    for (const environment of DRIFT_ENVIRONMENTS) {
      for (const observation of entry.observations[environment]) {
        if (
          observation.built_at &&
          observation.source_modified_at &&
          new Date(observation.built_at) < new Date(observation.source_modified_at)
        ) {
          staleOn.set(observation.path, [...(staleOn.get(observation.path) ?? []), environment]);
        }
        // §9 — `.packinglist` is the source of truth for what deploys. A file can be
        // correct, committed, and never reach a server.
        if (!observation.in_packinglist) {
          notListedOn.set(observation.path, [
            ...(notListedOn.get(observation.path) ?? []),
            environment,
          ]);
        }
      }
    }

    for (const [path, environments] of staleOn) {
      warnings.push({
        id: `stale_compile:${entry.columnKey}:${path}`,
        kind: 'stale_compile',
        severity: 'High',
        text: `${entry.label} was compiled before its source last changed. Binding is against the compiled bean, so the source being right does not help.`,
        where: `${environments.join(', ')} · ${path}`,
      });
    }

    for (const [path, environments] of notListedOn) {
      warnings.push({
        id: `not_in_packinglist:${entry.columnKey}:${path}`,
        kind: 'not_in_packinglist',
        severity: 'High',
        text: `${entry.label} is not in .packinglist, so it does not deploy however correct it is.`,
        where: `${environments.join(', ')} · ${path}`,
      });
    }

    // The join that makes this screen matter: the matrix says a deliverable is in prod,
    // the hashes say prod is not what was verified.
    const verdict = verdictFor(entry.byEnvironment);
    if (verdict !== 'In step') {
      const claiming = modules.filter((module) => {
        const cell = module.cells.find((candidate) => candidate.column_key === entry.columnKey);
        return cell ? toneOf(cell.status) === 'done' : false;
      });
      if (claiming.length > 0) {
        warnings.push({
          id: `claimed_but_drifted:${entry.columnKey}`,
          kind: 'claimed_but_drifted',
          severity: 'High',
          text: `${claiming.length} ${claiming.length === 1 ? 'module records' : 'modules record'} ${entry.label} as done in prod, but its prod hash is "${verdict}". Those cells are not evidence.`,
          where: `matrix · ${entry.label} · ${claiming
            .slice(0, 3)
            .map((module) => module.name)
            .join(', ')}${claiming.length > 3 ? ` +${claiming.length - 3}` : ''}`,
        });
      }
    }

    void lab;
  }

  // An agent that stopped reporting looks exactly like an environment that stopped
  // changing. Say which it is.
  for (const environment of DRIFT_ENVIRONMENTS) {
    const report = store.drift_reports
      .filter((candidate) => candidate.project_id === projectId && candidate.environment === environment)
      .sort((a, b) => (a.at < b.at ? 1 : -1))[0];

    if (!report) {
      warnings.push({
        id: `stale_report:${environment}`,
        kind: 'stale_report',
        severity: 'Med',
        text: `No agent has ever reported hashes from ${environment}. Everything shown for it is absence of data, not agreement.`,
        where: `${environment} · no report`,
      });
      continue;
    }

    const age = daysSince(report.at);
    if (age > STALE_REPORT_DAYS) {
      warnings.push({
        id: `stale_report:${environment}`,
        kind: 'stale_report',
        severity: 'Med',
        text: `The last report from ${environment} is ${Math.floor(age)} days old, so these hashes may no longer describe it.`,
        where: `${environment} · ${report.agent}`,
      });
    }
  }

  const order = { High: 0, Med: 1, Low: 2 } as const;
  return warnings.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * Records a promotion. It deliberately does **not** write prod observations: asserting a
 * hash nobody observed is exactly the habit this screen exists to break. The promoted set
 * is recorded, and the next agent report from prod either confirms it or does not.
 */
export function buildPromotion(
  store: StoreData,
  projectId: string,
  from: DriftEnvironment,
  to: DriftEnvironment,
  promotedBy: string,
): { id: string; hashes: Record<string, string> } {
  const hashes: Record<string, string> = {};
  for (const entry of resolve(store, projectId)) {
    const hash = entry.byEnvironment[from];
    if (hash) hashes[entry.columnKey] = hash;
  }
  return { id: randomUUID(), hashes };
}

/** A promotion is confirmed once prod reports exactly the hashes that were promoted. */
export function confirmPromotions(store: StoreData, projectId: string, at: string): number {
  let confirmed = 0;
  const current = Object.fromEntries(
    resolve(store, projectId).map((entry) => [entry.columnKey, entry.byEnvironment]),
  );

  for (const promotion of store.drift_promotions) {
    if (promotion.project_id !== projectId || promotion.confirmed_at) continue;
    const matched = Object.entries(promotion.hashes).every(
      ([columnKey, hash]) => current[columnKey]?.[promotion.to_environment] === hash,
    );
    if (matched) {
      promotion.confirmed_at = at;
      confirmed++;
    }
  }
  return confirmed;
}

/**
 * The gate, computed from the store. The rule itself lives in `lib/shared/promotion.ts`
 * so the static demo recomputes the same thing; this only supplies the project's columns.
 */
export function promotionGate(
  store: StoreData,
  projectId: string,
  modules: readonly ModuleView[],
  rows: readonly DriftRowView[],
) {
  const columns = store.columns.filter((column) => column.project_id === projectId);
  return computeGate(columns, modules, rows);
}
