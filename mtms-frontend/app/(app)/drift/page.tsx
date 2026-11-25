'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, PageTitle, SectionHeading } from '@/components/primitives';
import { get, send } from '@/lib/client/api';
import type { DriftVerdict } from '@/lib/shared/domain';
import {
  formatStamp,
  type DriftRowView,
  type DriftWarningView,
  type Snapshot,
} from '@/lib/shared/views';

/**
 * Drift.
 *
 * "Loaded in prod" is only true if the bytes on prod are the ones that passed preprod.
 * The same file exists in many places with different contents, compiled artifacts go
 * stale against source, and the deployed copy drifts from the repo copy — so identity
 * here is content hash, never path.
 *
 * Everything on this screen is derived from hashes an agent reported. Nothing is written
 * down in advance, including the warnings and the gate, so a fresh report changes all of
 * it at once. Where no agent has reported, the screen says so rather than showing
 * agreement it cannot vouch for.
 *
 * The screen is ordered to answer, in this order: what is out of sync, where the
 * mismatch is, why, and whether we can promote.
 */

const ENVIRONMENTS = ['repo', 'lab', 'preprod', 'prod'] as const;
type Environment = (typeof ENVIRONMENTS)[number];

type StatusGroup = 'in_sync' | 'drifted' | 'unverified' | 'not_deployed';

/**
 * One standardised status per engine verdict.
 *
 * The engine's own words ("In step", "Patched in place") are precise but inconsistent to
 * scan down a column, so the table shows a single vocabulary and the drawer keeps the
 * engine's term as part of the explanation. The mapping is one-to-one — no verdict is
 * invented and none is dropped.
 *
 * The glyphs are the matrix's own set from `STATUS_VOCABULARY`, not a second family
 * invented here: a filled circle is confirmed, a half circle is partway, an empty one is
 * nothing recorded, and `?` is nobody filled it in. The same mark therefore means the
 * same thing on this screen as it does on the grid. `◐` and `◑` are two distinct halves
 * on purpose — two statuses sharing a mark are indistinguishable however different their
 * names are.
 */
const STATUS: Record<DriftVerdict, { label: string; group: StatusGroup; mark: string }> = {
  'In step': { label: 'In sync', group: 'in_sync', mark: '●' },
  'Prod behind': { label: 'Prod behind', group: 'drifted', mark: '◐' },
  'Patched in place': { label: 'Modified in prod', group: 'drifted', mark: '◑' },
  'Never verified': { label: 'Unverified', group: 'unverified', mark: '?' },
  'Not deployed': { label: 'Not deployed', group: 'not_deployed', mark: '○' },
};

/**
 * One grey chip for every status in the table.
 *
 * The column used to vary fill as well — solid ink for a drift, an accent wash for a
 * match — which put three colour treatments in one narrow column. The glyph and the word
 * carry the status now, so the chip only has to be legible and identical to its
 * neighbours.
 */
const STATUS_CHIP = {
  background: 'var(--color-neutral-200)',
  color: 'var(--color-neutral-800)',
  borderColor: 'var(--color-neutral-400)',
} as const;

/**
 * Fill, outline and glyph — the house rule is that status is never carried by hue alone.
 *
 * Lettering is only ever ink or paper. An earlier version set the "in sync" text in
 * accent-800, which made three different text colours down one column and read as
 * decoration rather than meaning. The accent now appears as a fill behind ink text and
 * nowhere else, so what separates these badges is how filled they are, not what colour
 * they are.
 */
const TONE_STYLE = {
  ok: {
    background: 'var(--color-accent-200)',
    color: 'var(--color-text)',
    borderColor: 'var(--color-neutral-400)',
  },
  bad: {
    background: 'var(--color-text)',
    color: 'var(--color-bg)',
    borderColor: 'var(--color-text)',
  },
  warn: {
    background: 'transparent',
    color: 'var(--color-text)',
    borderColor: 'var(--color-neutral-400)',
  },
} as const;

const GROUP_LABEL: Record<StatusGroup, string> = {
  in_sync: 'In sync',
  drifted: 'Drifted',
  unverified: 'Unverified',
  not_deployed: 'Not deployed',
};

const SEVERITIES = ['High', 'Med', 'Low'] as const;
type Severity = (typeof SEVERITIES)[number];

/**
 * Warning ids are built server-side as `kind:columnKey[:path]`, except `stale_report`,
 * which is `stale_report:environment` and is about an agent rather than a deliverable.
 * That id is the only join from a warning back to its row — the view carries no column
 * key of its own.
 */
function columnKeyOf(warning: DriftWarningView): string | null {
  if (warning.kind === 'stale_report') return null;
  const [, columnKey] = warning.id.split(':');
  return columnKey || null;
}

/**
 * Why a row reads the way it does, in the engine's own terms.
 *
 * These sentences restate the rules in `DriftAnalysis.verdictFor` rather than guessing
 * from the hashes on screen, so the explanation cannot drift from the verdict it explains.
 */
function explain(row: DriftRowView): string {
  const repo = row.full_hashes.repo;
  const preprod = row.full_hashes.preprod;
  const prod = row.full_hashes.prod;

  switch (row.verdict) {
    case 'In step':
      return 'Every environment that has reported a hash reports the same one. Prod is running the bytes that were verified.';
    case 'Prod behind':
      return 'Preprod and prod report different hashes, so prod is not running the build preprod verified. A run on prod is not executing the code that was tested.';
    case 'Patched in place':
      return repo && preprod && preprod === prod
        ? 'Preprod and prod agree with each other but not with the repo, so the deployed copy was edited in place. The next deploy will silently revert it.'
        : 'Prod does not match the repo, so what is running there is not what is in source control.';
    case 'Never verified':
      return 'No agent has reported a hash from prod, so nothing can confirm what is running there. This is absence of evidence, not agreement.';
    case 'Not deployed':
      return 'The repo has a hash for this deliverable and no environment has reported one. That is usually a missing .packinglist entry — a file can be correct, committed, and still never reach a server.';
  }
}

/** The environments involved in the mismatch, so the drawer can point at it directly. */
function mismatchedEnvironments(row: DriftRowView): Set<Environment> {
  const { repo, preprod, prod } = row.full_hashes;
  switch (row.verdict) {
    case 'Prod behind':
      return new Set<Environment>(['preprod', 'prod']);
    case 'Patched in place':
      return repo && preprod && preprod === prod
        ? new Set<Environment>(['repo', 'preprod', 'prod'])
        : new Set<Environment>(['repo', 'prod']);
    case 'Never verified':
      return new Set<Environment>(['prod']);
    case 'Not deployed':
      return new Set<Environment>(['lab', 'preprod', 'prod']);
    default:
      return new Set<Environment>();
  }
}

function StatusTag({ verdict, small = false }: { verdict: DriftVerdict; small?: boolean }) {
  const status = STATUS[verdict];
  return (
    <span
      style={{
        fontFamily: 'var(--font-heading)',
        fontSize: small ? 11 : 12,
        letterSpacing: '.07em',
        textTransform: 'uppercase',
        padding: small ? '1px 6px' : '2px 8px',
        whiteSpace: 'nowrap',
        display: 'inline-block',
        borderWidth: 1,
        borderStyle: 'solid',
        ...STATUS_CHIP,
      }}
    >
      {/* A fixed box, so a narrow `?` and a round `●` still leave their labels on the
          same left edge down the column. */}
      <span
        aria-hidden
        style={{ display: 'inline-block', width: '1em', textAlign: 'center', marginRight: 2 }}
      >
        {status.mark}
      </span>
      {status.label}
    </span>
  );
}

export default function DriftPage() {
  const { snapshot, apply, can, reasonFor, setNotice, pending } = useTracker();
  const { rows, warnings, gate, reports, promotions } = snapshot.drift;
  const canPromote = can('prod.confirm');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | StatusGroup>('all');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [layerFilter, setLayerFilter] = useState('all');
  const [missingOn, setMissingOn] = useState<'any' | Environment>('any');
  const [severityFilter, setSeverityFilter] = useState<'all' | Severity>('all');
  const [expandedWarning, setExpandedWarning] = useState<string | null>(null);

  const selected = rows.find((row) => row.id === selectedId) ?? null;

  // A drawer that cannot be dismissed from the keyboard is a trap.
  useEffect(() => {
    if (!selectedId) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  async function promote() {
    const meta = await apply(null, () =>
      send<Snapshot>('/api/v1/drift/promote', 'POST', { from: 'preprod', to: 'prod' }),
    );
    if (meta) {
      setNotice(
        `Promotion recorded for ${meta.columns} deliverables. Nothing on prod has changed yet — it stays unconfirmed until an agent reports those exact hashes back from prod.`,
      );
    }
  }

  /** Re-reads the projection. Hashes only change when an agent reports, so this is a read. */
  async function refresh() {
    await apply(null, () => get<Snapshot>('/api/v1/snapshot'));
  }

  const promoteDisabled = !canPromote || !gate.can_promote;
  const promoteReason = !canPromote
    ? reasonFor('prod.confirm')
    : gate.can_promote
      ? ''
      : `Blocked — ${gate.checks.filter((check) => !check.passed).map((check) => check.text).join('; ')}`;

  const counts = useMemo(() => {
    const tally: Record<StatusGroup, number> = {
      in_sync: 0,
      drifted: 0,
      unverified: 0,
      not_deployed: 0,
    };
    for (const row of rows) tally[STATUS[row.verdict].group] += 1;
    return tally;
  }, [rows]);

  const severityCounts = useMemo(() => {
    const tally: Record<Severity, number> = { High: 0, Med: 0, Low: 0 };
    for (const warning of warnings) {
      if (warning.severity in tally) tally[warning.severity as Severity] += 1;
    }
    return tally;
  }, [warnings]);

  const scopeOptions = useMemo(
    () => [...new Set(rows.map((row) => row.scope))].sort(),
    [rows],
  );
  const layerOptions = useMemo(
    () => [...new Set(rows.map((row) => row.code_layer))].sort(),
    [rows],
  );

  /**
   * Which environments have stopped reporting, taken from the engine's own staleness
   * warning rather than recomputed here — one rule, one answer, and no clock in render.
   */
  const staleEnvironments = useMemo(
    () =>
      new Set(
        warnings
          .filter((warning) => warning.kind === 'stale_report')
          .map((warning) => warning.id.split(':')[1]),
      ),
    [warnings],
  );

  const environmentSummary = useMemo(
    () =>
      ENVIRONMENTS.map((environment) => {
        const report = reports.find((entry) => entry.environment === environment);
        const reported = rows.filter((row) => row.full_hashes[environment]).length;
        const driftedHere =
          environment === 'prod'
            ? rows.filter((row) => STATUS[row.verdict].group === 'drifted').length
            : 0;

        let status: string;
        let tone: 'ok' | 'warn' | 'bad';
        let detail: string;
        if (!report?.at) {
          status = 'Not reported';
          tone = 'warn';
          detail = 'No agent has ever reported hashes from here.';
        } else if (staleEnvironments.has(environment)) {
          status = 'Stale';
          tone = 'warn';
          detail = 'The last report is old enough that these hashes may no longer describe it.';
        } else if (driftedHere > 0) {
          status = 'Drifted';
          tone = 'bad';
          detail = `${driftedHere} ${driftedHere === 1 ? 'deliverable does' : 'deliverables do'} not match what was verified.`;
        } else if (reported < rows.length) {
          status = 'Incomplete';
          tone = 'warn';
          detail = `${rows.length - reported} tracked ${rows.length - reported === 1 ? 'deliverable has' : 'deliverables have'} no hash from here.`;
        } else {
          status = 'In sync';
          tone = 'ok';
          detail = 'Every tracked deliverable has a hash reported from here.';
        }

        return { environment, report, reported, status, tone, detail };
      }),
    [reports, rows, staleEnvironments],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== 'all' && STATUS[row.verdict].group !== statusFilter) return false;
      if (scopeFilter !== 'all' && row.scope !== scopeFilter) return false;
      if (layerFilter !== 'all' && row.code_layer !== layerFilter) return false;
      if (missingOn !== 'any' && row.full_hashes[missingOn]) return false;
      if (!needle) return true;

      const haystack = [
        row.layer,
        row.scope,
        row.cadence,
        row.code_layer,
        row.verdict,
        STATUS[row.verdict].label,
        ...row.paths,
        ...ENVIRONMENTS.map((environment) => row[environment]),
        ...ENVIRONMENTS.map((environment) => row.full_hashes[environment] ?? ''),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, query, statusFilter, scopeFilter, layerFilter, missingOn]);

  const warningsByColumn = useMemo(() => {
    const map = new Map<string, DriftWarningView[]>();
    for (const warning of warnings) {
      const key = columnKeyOf(warning);
      if (!key) continue;
      map.set(key, [...(map.get(key) ?? []), warning]);
    }
    return map;
  }, [warnings]);

  const shownWarnings = useMemo(
    () =>
      severityFilter === 'all'
        ? warnings
        : warnings.filter((warning) => warning.severity === severityFilter),
    [warnings, severityFilter],
  );

  const lastChecked =
    reports
      .map((report) => report.at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;

  const filtersActive =
    statusFilter !== 'all' ||
    scopeFilter !== 'all' ||
    layerFilter !== 'all' ||
    missingOn !== 'any' ||
    query.trim() !== '';

  return (
    <div className="page page-narrow">
      <PageTitle
        title="Drift"
        lede="Compare deliverables across environments and identify deployment inconsistencies."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span style={{ fontSize: 12, color: 'var(--color-neutral-700)', whiteSpace: 'nowrap' }}>
              {lastChecked ? <>Last checked {formatStamp(lastChecked)}</> : 'Never checked'}
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void refresh()}
              disabled={pending}
              title="Re-read the latest agent reports"
            >
              {pending ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        }
      />

      {/* When each environment was last looked at, and whether it agrees. An agent that
          stopped reporting looks exactly like an environment that stopped changing. */}
      <div
        className="bordered"
        style={{ display: 'flex', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}
      >
        {environmentSummary.map((entry) => (
          <div
            key={entry.environment}
            style={{
              flex: '1 1 170px',
              minWidth: 0,
              padding: 'var(--space-3) var(--space-4)',
              borderRight: '1px solid var(--color-divider)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 'var(--space-2)',
              }}
            >
              <span
                className="kicker"
                style={{ letterSpacing: '.11em', fontWeight: 700, color: 'var(--color-text)' }}
              >
                {entry.environment}
              </span>
              <span
                title={entry.detail}
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: 11,
                  letterSpacing: '.07em',
                  textTransform: 'uppercase',
                  padding: '1px 6px',
                  whiteSpace: 'nowrap',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  ...TONE_STYLE[entry.tone],
                }}
              >
                {entry.status}
              </span>
            </div>
            <div className="tabular" style={{ fontSize: 13, marginTop: 2 }}>
              {entry.reported}/{rows.length} deliverables
            </div>
            {/* Agent and date share the last line, pushed to the foot of the tile so the
                dates line up across all four however tall any one tile gets. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 'var(--space-2)',
                marginTop: 'auto',
                paddingTop: 'var(--space-2)',
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: 'var(--color-neutral-600)',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={entry.report?.agent}
              >
                {entry.report?.agent ?? '—'}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--color-neutral-600)',
                  flex: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {entry.report?.at ? formatStamp(entry.report.at) : 'never reported'}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Filters. The status dropdown carries the drift overview with it — each option
          states how many rows it would leave — so the counts and the rows behind them can
          never tell different stories. Scope and layer are the deliverable's own fields;
          "no hash on" is the question an operator actually asks of an environment. */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
          alignItems: 'center',
          marginBottom: 'var(--space-3)',
        }}
      >
        <input
          className="input"
          style={{ flex: '1 1 220px', minWidth: 160 }}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search deliverable, path or hash…"
          aria-label="Search deliverables"
        />
        <select
          className="input"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as 'all' | StatusGroup)}
          aria-label="Filter by status"
        >
          <option value="all">All statuses · {rows.length}</option>
          {(Object.keys(GROUP_LABEL) as StatusGroup[]).map((group) => (
            <option key={group} value={group}>
              {GROUP_LABEL[group]} · {counts[group]}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={scopeFilter}
          onChange={(event) => setScopeFilter(event.target.value)}
          aria-label="Filter by scope"
        >
          <option value="all">Any scope</option>
          {scopeOptions.map((scope) => (
            <option key={scope} value={scope}>
              {scope}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={layerFilter}
          onChange={(event) => setLayerFilter(event.target.value)}
          aria-label="Filter by layer"
        >
          <option value="all">Any layer</option>
          {layerOptions.map((layer) => (
            <option key={layer} value={layer}>
              {layer}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={missingOn}
          onChange={(event) => setMissingOn(event.target.value as 'any' | Environment)}
          aria-label="Filter by environment with no reported hash"
        >
          <option value="any">Any environment</option>
          {ENVIRONMENTS.map((environment) => (
            <option key={environment} value={environment}>
              No hash on {environment}
            </option>
          ))}
        </select>
        {filtersActive ? (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setQuery('');
              setStatusFilter('all');
              setScopeFilter('all');
              setLayerFilter('all');
              setMissingOn('any');
            }}
          >
            Clear
          </button>
        ) : null}
        <span
          className="tabular"
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            color: 'var(--color-neutral-700)',
            whiteSpace: 'nowrap',
          }}
        >
          {shown.length} of {rows.length} tracked
        </span>
      </div>

      <div className="bordered" style={{ overflowX: 'auto', marginBottom: 'var(--space-8)' }}>
        <table className="table" style={{ minWidth: 820 }}>
          <thead>
            <tr>
              <th>Deliverable</th>
              <th>Scope</th>
              <th>Repo</th>
              <th>Lab</th>
              <th>Preprod</th>
              <th>Prod</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const mismatched = mismatchedEnvironments(row);
              return (
                <tr
                  key={row.id}
                  tabIndex={0}
                  aria-label={`${row.layer} — ${STATUS[row.verdict].label}. Open details.`}
                  title="Open details"
                  onClick={() => setSelectedId(row.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedId(row.id);
                    }
                  }}
                  style={{
                    cursor: 'pointer',
                    background: row.id === selectedId ? 'var(--color-accent-100)' : undefined,
                  }}
                >
                  <td>
                    <span
                      style={{
                        fontFamily: 'var(--font-heading)',
                        fontSize: 15,
                        letterSpacing: '.05em',
                        textTransform: 'uppercase',
                      }}
                    >
                      {row.layer}
                    </span>
                    <div style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
                      {row.code_layer} · {row.cadence}
                    </div>
                  </td>
                  <td>
                    <span className="tag tag-outline">{row.scope}</span>
                  </td>
                  {ENVIRONMENTS.map((environment) => {
                    const full = row.full_hashes[environment];
                    const flagged = mismatched.has(environment);
                    return (
                      <td
                        key={environment}
                        className="mono"
                        style={{
                          fontSize: 12,
                          color: full ? undefined : 'var(--color-neutral-600)',
                          // The mismatch is the whole point of the row, so mark exactly
                          // the cells that disagree rather than colouring the row.
                          fontWeight: flagged ? 600 : undefined,
                          textDecoration: flagged ? 'underline' : undefined,
                          textDecorationStyle: flagged ? 'dotted' : undefined,
                          textUnderlineOffset: 3,
                        }}
                        // The six characters are for reading; the identity is the whole hash.
                        title={full ? `sha256 ${full}` : `no hash reported from ${environment}`}
                      >
                        {row[environment]}
                      </td>
                    );
                  })}
                  <td>
                    <StatusTag verdict={row.verdict} />
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ fontSize: 13, color: 'var(--color-neutral-600)' }}>
                  No deliverables are set up for hash tracking on this project.
                </td>
              </tr>
            ) : null}
            {rows.length > 0 && shown.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ fontSize: 13, color: 'var(--color-neutral-600)' }}>
                  No deliverables match those filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div
        className="split"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-8)',
          alignItems: 'start',
        }}
      >
        <div>
          <SectionHeading first>Open warnings</SectionHeading>
          <div className="bordered">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                flexWrap: 'wrap',
                padding: 'var(--space-3) var(--space-4)',
                borderBottom: '1px solid var(--color-divider)',
              }}
            >
              <span
                className="tabular"
                style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 600 }}
              >
                {warnings.length}
              </span>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--color-neutral-700)' }}>
                {warnings.length === 1 ? 'warning' : 'warnings'}
              </span>
              {SEVERITIES.filter((severity) => severityCounts[severity] > 0).map((severity) => (
                <button
                  key={severity}
                  type="button"
                  aria-pressed={severityFilter === severity}
                  onClick={() =>
                    setSeverityFilter(severityFilter === severity ? 'all' : severity)
                  }
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontSize: 12,
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                    padding: '1px 7px',
                    cursor: 'pointer',
                    borderWidth: 1,
                    borderStyle: 'solid',
                    ...(severityFilter === severity
                      ? TONE_STYLE.bad
                      : severity === 'High'
                        ? { background: 'transparent', color: 'var(--color-text)', borderColor: 'var(--color-text)' }
                        : {
                            background: 'transparent',
                            color: 'var(--color-neutral-700)',
                            borderColor: 'var(--color-neutral-400)',
                          }),
                  }}
                >
                  {severity} {severityCounts[severity]}
                </button>
              ))}
            </div>

            {/* Scrolls rather than growing. This panel sits beside Promotion readiness,
                and a list long enough to run past it pushes the rest of the page down for
                the sake of warnings nobody has read yet. */}
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {shownWarnings.map((warning) => {
                const columnKey = columnKeyOf(warning);
                const row = columnKey
                  ? rows.find((candidate) => candidate.column_key === columnKey)
                  : null;
                const open = expandedWarning === warning.id;
                return (
                  <div
                    key={warning.id}
                    style={{ borderBottom: '1px solid var(--color-divider)' }}
                  >
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpandedWarning(open ? null : warning.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 'var(--space-3)',
                        width: '100%',
                        textAlign: 'left',
                        padding: 'var(--space-2) var(--space-4)',
                        border: 0,
                        background: 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        font: 'inherit',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--font-heading)',
                          fontSize: 11,
                          letterSpacing: '.1em',
                          textTransform: 'uppercase',
                          padding: '1px 6px',
                          flex: 'none',
                          borderWidth: 1,
                          borderStyle: 'solid',
                          ...(warning.severity === 'High' ? TONE_STYLE.bad : TONE_STYLE.warn),
                        }}
                      >
                        {warning.severity}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          fontSize: 13,
                          lineHeight: 1.35,
                          // One line until asked for: a warnings list that scrolls for a
                          // page stops being read, which is how the urgent one gets missed.
                          ...(open
                            ? { textWrap: 'pretty' as const }
                            : {
                                display: '-webkit-box',
                                WebkitLineClamp: 1,
                                WebkitBoxOrient: 'vertical' as const,
                                overflow: 'hidden',
                              }),
                        }}
                      >
                        {warning.text}
                      </span>
                      <span
                        aria-hidden
                        style={{ flex: 'none', fontSize: 11, color: 'var(--color-neutral-600)' }}
                      >
                        {open ? '−' : '+'}
                      </span>
                    </button>

                    {open ? (
                      <div style={{ padding: '0 var(--space-4) var(--space-3)' }}>
                        <div style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
                          {warning.where}
                        </div>
                        {row ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ marginTop: 'var(--space-2)', fontSize: 13 }}
                            onClick={() => setSelectedId(row.id)}
                          >
                            Open {row.layer}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}

              {warnings.length === 0 ? (
                <div style={{ padding: 'var(--space-4)', fontSize: 13, color: 'var(--color-neutral-600)' }}>
                  Nothing outstanding — every deliverable matches across the environments that
                  have reported.
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div>
          <SectionHeading first>Promotion readiness</SectionHeading>
          <Blueprint>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-3)',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>
                {gate.can_promote
                  ? 'Every gate passes.'
                  : `${gate.blocked} ${gate.blocked === 1 ? 'blocker' : 'blockers'} preventing promotion`}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: 12,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  padding: '2px 8px',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  ...(gate.can_promote ? TONE_STYLE.ok : TONE_STYLE.bad),
                }}
              >
                {gate.can_promote ? 'Promotion ready' : 'Promotion blocked'}
              </span>
            </div>

            {gate.checks.map((check) => (
              <div
                key={check.text}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-2) 0',
                  borderTop: '1px solid var(--color-divider)',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 14,
                    flex: 'none',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--color-text)',
                  }}
                >
                  {/* Filled means the gate is met, empty means it is not — the same
                      circles the status column uses. A cross here read as a button to
                      dismiss the row rather than a statement about it. */}
                  {check.passed ? '●' : '○'}
                </span>
                <span style={{ flex: 1, fontSize: 13, textWrap: 'pretty' }}>{check.text}</span>
                <span style={{ fontSize: 12, color: 'var(--color-neutral-600)', flex: 'none' }}>
                  {check.detail}
                </span>
              </div>
            ))}

            {/* Primary only while it can actually be pressed. A blue call-to-action that
                never responds reads as a broken control rather than a gated one, and the
                gates fail far more often than they pass. */}
            <button
              type="button"
              className={`btn btn-block ${promoteDisabled ? 'btn-secondary' : 'btn-primary'}`}
              disabled={promoteDisabled}
              title={promoteReason || undefined}
              onClick={() => void promote()}
              style={{ marginTop: 'var(--space-6)' }}
            >
              {gate.label}
            </button>

            <div
              style={{
                marginTop: 'var(--space-3)',
                fontSize: 12,
                color: 'var(--color-neutral-700)',
                textWrap: 'pretty',
              }}
            >
              {/* Not the blocked reason: that is the list of failed gates, which is the
                  list immediately above this. A missing permission is the one case
                  nothing else on screen explains, so it is the one case worth the space.
                  The full reason still rides on the button's tooltip. */}
              {canPromote
                ? 'Promotion copies hashes; it never rebuilds. Recording one does not change prod — it records the exact bytes that should now be there, and stays unconfirmed until an agent reports them back.'
                : reasonFor('prod.confirm')}
            </div>
          </Blueprint>

          {promotions.length > 0 ? (
            <>
              <SectionHeading>Recent promotions</SectionHeading>
              <div className="bordered">
                {promotions.map((promotion) => (
                  <div
                    key={promotion.id}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 'var(--space-3)',
                      padding: 'var(--space-2) var(--space-4)',
                      borderBottom: '1px solid var(--color-divider)',
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-heading)',
                        letterSpacing: '.06em',
                        textTransform: 'uppercase',
                        flex: 'none',
                      }}
                    >
                      {promotion.from_environment} → {promotion.to_environment}
                    </span>
                    <span style={{ flex: 1, color: 'var(--color-neutral-700)' }}>
                      {promotion.column_count} deliverables ·{' '}
                      {promotion.confirmed_at ? (
                        <>confirmed {formatStamp(promotion.confirmed_at)}</>
                      ) : (
                        <span style={{ color: 'var(--color-text)' }}>awaiting confirmation</span>
                      )}
                    </span>
                    <span style={{ color: 'var(--color-neutral-600)', flex: 'none' }}>
                      {promotion.promoted_by}, {formatStamp(promotion.at)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* How the numbers get here. Operationally irrelevant until it is the thing that is
          broken, so it is one click away rather than on the page. */}
      <details style={{ marginTop: 'var(--space-8)' }}>
        <summary
          className="section-heading"
          style={{ cursor: 'pointer', fontSize: 13, color: 'var(--color-neutral-700)' }}
        >
          Technical details
        </summary>
        <div
          style={{
            marginTop: 'var(--space-3)',
            fontSize: 12,
            color: 'var(--color-neutral-700)',
            textWrap: 'pretty',
            maxWidth: '78ch',
          }}
        >
          Hashes come from <span className="mono">agent/report_hashes.py</span>, which runs on
          each environment and posts to <span className="mono">/api/v1/drift/reports</span>. It
          is written for Python 2.6+ and reads <span className="mono">.packinglist</span> for
          what actually deploys, because a file in the repo and absent from that list never
          reaches a server. A deliverable made of several files is identified by the hash of its
          sorted <span className="mono">path\0hash</span> pairs, so changing any file in the set
          changes the deliverable&rsquo;s identity and the order the agent reported them in does
          not. Nothing on this screen is stored pre-computed: every verdict, warning and gate is
          derived from the reported hashes on read.
        </div>
      </details>

      {selected ? (
        <DetailDrawer
          row={selected}
          warnings={warningsByColumn.get(selected.column_key) ?? []}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The right-hand detail drawer.
 *
 * It answers one deliverable's "where is the mismatch, and why", and deliberately stops
 * there: no content diff is possible because agents report hashes, never file contents,
 * and inventing one would undo the only guarantee this screen makes.
 */
function DetailDrawer({
  row,
  warnings,
  onClose,
}: {
  row: DriftRowView;
  warnings: DriftWarningView[];
  onClose: () => void;
}) {
  const mismatched = mismatchedEnvironments(row);

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(29, 31, 32, 0.3)',
          zIndex: 40,
        }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${row.layer} drift detail`}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(460px, 100%)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-bg)',
          borderLeft: '1px solid var(--color-neutral-400)',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 41,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-5)',
            borderBottom: '1px solid var(--color-divider)',
            flex: 'none',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h4 style={{ margin: 0, wordBreak: 'break-word' }}>{row.layer}</h4>
            <div style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
              {row.code_layer} · {row.cadence} · {row.scope}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            style={{
              flex: 'none',
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: 2,
              color: 'var(--color-neutral-700)',
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: 'var(--space-5)' }}>
          <div style={{ marginBottom: 'var(--space-5)' }}>
            <StatusTag verdict={row.verdict} />
          </div>

          <div className="kicker" style={{ marginBottom: 'var(--space-2)' }}>
            Environment comparison
          </div>
          <div className="bordered" style={{ marginBottom: 'var(--space-5)' }}>
            {ENVIRONMENTS.map((environment) => {
              const full = row.full_hashes[environment];
              const flagged = mismatched.has(environment);
              return (
                <div
                  key={environment}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-2) var(--space-3)',
                    borderBottom: '1px solid var(--color-divider)',
                    background: flagged ? 'var(--color-accent-100)' : undefined,
                  }}
                >
                  <span
                    className="kicker"
                    style={{ width: 62, flex: 'none', letterSpacing: '.11em' }}
                  >
                    {environment}
                  </span>
                  <span
                    className="mono"
                    style={{
                      flex: 1,
                      fontSize: 12,
                      wordBreak: 'break-all',
                      color: full ? 'var(--color-text)' : 'var(--color-neutral-600)',
                      fontWeight: flagged ? 600 : undefined,
                    }}
                    title={full ?? undefined}
                  >
                    {full ? full.slice(0, 16) : 'no hash reported'}
                  </span>
                  {flagged ? (
                    <span
                      style={{
                        flex: 'none',
                        fontFamily: 'var(--font-heading)',
                        fontSize: 11,
                        letterSpacing: '.08em',
                        textTransform: 'uppercase',
                        color: 'var(--color-accent-800)',
                      }}
                    >
                      mismatch
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="kicker" style={{ marginBottom: 'var(--space-2)' }}>
            Why is this {STATUS[row.verdict].label.toLowerCase()}?
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5, textWrap: 'pretty' }}>{explain(row)}</div>
          <div
            style={{
              marginTop: 'var(--space-2)',
              fontSize: 12,
              color: 'var(--color-neutral-600)',
            }}
          >
            Engine verdict: <span className="mono">{row.verdict}</span>
          </div>

          {row.paths.length > 0 ? (
            <>
              <div
                className="kicker"
                style={{ marginTop: 'var(--space-5)', marginBottom: 'var(--space-2)' }}
              >
                Files
              </div>
              <div className="bordered">
                {row.paths.map((path) => (
                  <div
                    key={path}
                    className="mono"
                    style={{
                      fontSize: 11,
                      padding: 'var(--space-2) var(--space-3)',
                      borderBottom: '1px solid var(--color-divider)',
                      wordBreak: 'break-all',
                      color: 'var(--color-neutral-700)',
                    }}
                  >
                    {path}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {warnings.length > 0 ? (
            <>
              <div
                className="kicker"
                style={{ marginTop: 'var(--space-5)', marginBottom: 'var(--space-2)' }}
              >
                Warnings on this deliverable
              </div>
              <div className="bordered">
                {warnings.map((warning) => (
                  <div
                    key={warning.id}
                    style={{
                      padding: 'var(--space-2) var(--space-3)',
                      borderBottom: '1px solid var(--color-divider)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
                      <span
                        style={{
                          fontFamily: 'var(--font-heading)',
                          fontSize: 11,
                          letterSpacing: '.1em',
                          textTransform: 'uppercase',
                          padding: '1px 6px',
                          flex: 'none',
                          borderWidth: 1,
                          borderStyle: 'solid',
                          ...(warning.severity === 'High' ? TONE_STYLE.bad : TONE_STYLE.warn),
                        }}
                      >
                        {warning.severity}
                      </span>
                      <span style={{ flex: 1, fontSize: 12, lineHeight: 1.35, textWrap: 'pretty' }}>
                        {warning.text}
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: 2,
                        fontSize: 11,
                        color: 'var(--color-neutral-600)',
                        wordBreak: 'break-all',
                      }}
                    >
                      {warning.where}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {/* Actions the service does not expose yet. Shown disabled rather than hidden,
              because a control that is missing reads as a feature nobody thought of, and
              one that is gated says what would have to exist for it to work. */}
          <div
            className="kicker"
            style={{ marginTop: 'var(--space-5)', marginBottom: 'var(--space-2)' }}
          >
            Actions
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            {[
              ['View diff', 'Agents report hashes, not file contents, so there is nothing to diff from here.'],
              ['View history', 'Per-deliverable hash history is not recorded — only the latest report per environment.'],
              ['Acknowledge', 'Warnings are derived on every read, so there is nothing to acknowledge against.'],
            ].map(([label, reason]) => (
              <button key={label} type="button" className="btn btn-secondary" disabled title={reason}>
                {label}
              </button>
            ))}
          </div>
          <div
            style={{
              marginTop: 'var(--space-2)',
              fontSize: 11,
              color: 'var(--color-neutral-600)',
              textWrap: 'pretty',
            }}
          >
            Promotion is a whole-environment action and lives in Promotion readiness. The rest
            are unavailable until the service records more than the latest hash per environment.
          </div>
        </div>
      </aside>
    </>
  );
}
