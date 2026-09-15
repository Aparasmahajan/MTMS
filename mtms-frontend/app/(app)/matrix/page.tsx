'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTracker } from '@/components/TrackerProvider';
import { Chip, NotConfigured, StatusMarker } from '@/components/primitives';
import { send } from '@/lib/client/api';
import { optimisticAdvance } from '@/lib/client/optimistic';
import { STATUS_VOCABULARY, TONE_STYLE } from '@/lib/shared/vocabulary';
import { groupColumns } from '@/lib/shared/views';
import type { CellView, ColumnView, SubModuleView, Snapshot } from '@/lib/shared/views';

/**
 * The module matrix — the spreadsheet, made editable.
 *
 * Geometry is fixed so the sticky first column and sticky header row line up: a 326px
 * module cell, an 82px readiness cell, one cell per configured column, and a 96px target
 * cell. The container's min-width is the sum, so both axes scroll.
 *
 * A deliverable loaded per environment is three columns under one spanning header, and
 * those are narrow — three 48px ticks come to less than two ordinary columns, which is
 * what keeps eighteen environment columns on a grid that used to hold six.
 */

const NAME_WIDTH = 326;
const READY_WIDTH = 82;
const CELL_WIDTH = 76;
const ENV_CELL_WIDTH = 48;
const TARGET_WIDTH = 96;

const widthOf = (column: ColumnView): number => (column.environment ? ENV_CELL_WIDTH : CELL_WIDTH);

/**
 * The rule the eye reads the grid by: environments inside one deliverable are divided
 * faintly, deliverables from each other firmly. Without it eighteen equally-spaced ticks
 * give no clue where FILECR ends and CLICR begins.
 */
function groupEdge(columns: readonly ColumnView[], index: number): string {
  const here = columns[index];
  const next = columns[index + 1];
  const sameGroup = Boolean(here?.group_key) && here?.group_key === next?.group_key;
  return sameGroup ? 'var(--color-neutral-200)' : 'var(--color-divider)';
}

const READINESS_FILTERS = ['All', 'Loaded in prod', 'Partial', 'Not started', 'Has blanks'] as const;
type ReadinessFilter = (typeof READINESS_FILTERS)[number];

function MatrixScreen() {
  const { snapshot, apply, can, reasonFor, setNotice, subModuleHref } = useTracker();
  const router = useRouter();
  const params = useSearchParams();

  const moduleFilter = params.get('node') ?? 'All';
  const readyParam = params.get('ready') ?? 'All';
  const readyFilter: ReadinessFilter = (READINESS_FILTERS as readonly string[]).includes(readyParam)
    ? (readyParam as ReadinessFilter)
    : 'All';

  // Expansion is local UI state — it is not worth a round trip or a URL.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Columns behind a switched-off environment are still in the snapshot, cells and all —
  // they simply do not draw. See `ColumnView.active`.
  const columns = useMemo(
    () => snapshot.config.columns.filter((column) => column.active),
    [snapshot.config.columns],
  );
  const columnGroups = useMemo(() => groupColumns(snapshot.config.columns), [snapshot.config.columns]);
  const hiddenEnvironments = snapshot.config.environments.filter(
    (environment) => !environment.enabled,
  );
  const editable = can('deliverable.update');

  function setFilter(next: { node?: string; ready?: string }) {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (!value || value === 'All') query.delete(key);
      else query.set(key, value);
    }
    router.replace(query.size ? `/matrix?${query}` : '/matrix', { scroll: false });
  }

  const shown = useMemo(() => {
    let subModules = snapshot.sub_modules;
    if (moduleFilter !== 'All') subModules = subModules.filter((subModule) => subModule.module_name === moduleFilter);
    if (readyFilter === 'Loaded in prod') subModules = subModules.filter((subModule) => subModule.readiness === 100);
    else if (readyFilter === 'Partial')
      subModules = subModules.filter((subModule) => subModule.readiness > 0 && subModule.readiness < 100);
    else if (readyFilter === 'Not started') subModules = subModules.filter((subModule) => subModule.readiness === 0);
    else if (readyFilter === 'Has blanks') subModules = subModules.filter((subModule) => subModule.blank_count > 0);
    return subModules;
  }, [snapshot.sub_modules, moduleFilter, readyFilter]);

  const groups = snapshot.config.module_names
    .map((moduleName) => ({
      moduleName,
      rows: shown.filter((subModule) => subModule.module_name === moduleName),
    }))
    .filter((group) => group.rows.length > 0);

  function toggle(subModuleId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(subModuleId)) next.delete(subModuleId);
      else next.add(subModuleId);
      return next;
    });
  }

  function advance(subModule: SubModuleView, cell: CellView, subActivityId: string | null) {
    if (!editable) {
      setNotice(reasonFor('deliverable.update'));
      return;
    }
    if (subModule.closed) {
      setNotice('This module is closed. Reopen it from the module screen before changing a cell.');
      return;
    }
    void apply(
      (current) =>
        optimisticAdvance(
          current,
          subModule.id,
          subActivityId,
          cell.column_key,
          current.me.display_name,
        ),
      () =>
        send<Snapshot>('/api/v1/cells', 'PATCH', {
          sub_module_id: subModule.id,
          sub_activity_id: subActivityId,
          column_key: cell.column_key,
        }),
    );
  }

  const minWidth =
    NAME_WIDTH +
    READY_WIDTH +
    TARGET_WIDTH +
    columns.reduce((total, column) => total + widthOf(column), 0);

  /**
   * `aria-rowindex` is 1-based over the *whole* grid, so both header rows, each node-type
   * group header, each module and every expanded sub-activity all consume one. A running
   * counter during render is the only way to get that right when the visible rows depend
   * on which modules are open.
   */
  let rowIndex = 2;
  const rowCount =
    2 +
    groups.length +
    groups.reduce(
      (total, group) =>
        total +
        group.rows.length +
        group.rows.reduce(
          (subs, subModule) => subs + (expanded.has(subModule.id) ? subModule.sub_activities.length : 0),
          0,
        ),
      0,
    );

  return (
    <div className="page-full">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 'var(--space-6)',
          marginBottom: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1>Sub-module matrix</h1>
          <div className="lede">
            One row per sub-module — a module plus an activity. Open one to reach its
            sub-activities; a sub-module cell is a roll-up of them. Every change is stamped with who and
            when.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-6)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <div className="kicker" style={{ fontSize: 11, marginBottom: 'var(--space-1)' }}>
              Module
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
              {['All', ...snapshot.config.module_names].map((moduleName) => (
                <Chip
                  key={moduleName}
                  label={moduleName}
                  active={moduleFilter === moduleName}
                  onClick={() => setFilter({ node: moduleName })}
                />
              ))}
            </div>
          </div>
          <div>
            <div className="kicker" style={{ fontSize: 11, marginBottom: 'var(--space-1)' }}>
              Readiness
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
              {READINESS_FILTERS.map((filter) => (
                <Chip
                  key={filter}
                  label={filter}
                  active={readyFilter === filter}
                  onClick={() => setFilter({ ready: filter })}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 'var(--space-6)',
          flexWrap: 'wrap',
          marginBottom: 'var(--space-4)',
          fontSize: 12,
          color: 'var(--color-neutral-700)',
        }}
      >
        {/*
          The statuses actually on this grid. A per-environment deliverable takes a plain
          Loaded / Not Loaded tick — which environment it is loaded on is the column, not
          the status, and that is the whole point of the split.
        */}
        {(['loaded', 'notloaded', 'pending', 'blank'] as const).map((key) => {
          const entry = STATUS_VOCABULARY[key]!;
          const tone = TONE_STYLE[entry.tone];
          return (
            <span key={key} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span
                aria-hidden
                style={{
                  width: 20,
                  height: 20,
                  flex: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  background: tone.bg,
                  color: tone.fg,
                  border: `1px solid ${tone.border}`,
                }}
              >
                {entry.mark}
              </span>
              {key === 'blank' ? 'Never filled in' : entry.label}
            </span>
          );
        })}
      </div>

      <div className="bordered" style={{ overflow: 'auto', maxHeight: '74vh' }}>
        {/*
          A real grid, not a table of divs. Screen readers announce "row 4 of 23, column
          6 of 17" only if the roles and the counts are here — and the counts have to be
          the *whole* grid, including the group headers and any expanded sub-activities,
          which is why they are computed rather than taken from `groups.length`.
        */}
        <div
          role="grid"
          aria-label={`Deliverable matrix for ${snapshot.project.key}`}
          aria-rowcount={rowCount}
          aria-colcount={columns.length + 3}
          style={{ minWidth }}
        >
          {/*
            Two header rows, sticky as one block. The upper names the deliverable and
            spans its environment columns; the lower names the environment. A grouped
            column's own label is only ever LAB / PRE / PROD, so without the row above it
            the grid would be eighteen columns saying which environment and never which
            deliverable.
          */}
          <div
            role="rowgroup"
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 12,
              background: 'var(--color-bg)',
              borderBottom: '1px solid var(--color-neutral-400)',
            }}
          >
            <div role="row" aria-rowindex={1} style={{ display: 'flex' }}>
              <div
                role="columnheader"
                aria-colindex={1}
                className="kicker"
                style={{
                  width: NAME_WIDTH,
                  flex: 'none',
                  position: 'sticky',
                  left: 0,
                  zIndex: 13,
                  background: 'var(--color-bg)',
                  padding: 'var(--space-3) var(--space-4) var(--space-1)',
                  borderRight: '1px solid var(--color-divider)',
                  letterSpacing: '.11em',
                }}
              >
                Sub-module — module + activity
              </div>
              <div
                role="columnheader"
                aria-colindex={2}
                className="kicker"
                style={{
                  width: READY_WIDTH,
                  flex: 'none',
                  padding: 'var(--space-3) var(--space-2) var(--space-1)',
                  borderRight: '1px solid var(--color-divider)',
                  letterSpacing: '.08em',
                }}
              >
                Ready
              </div>
              {columnGroups.map((group, index) => {
                const spanned = group.members.reduce((total, column) => total + widthOf(column), 0);
                const split = group.members.length > 1;
                return (
                  <div
                    key={group.key}
                    role="columnheader"
                    aria-colindex={index + 3}
                    title={split ? `${group.members[0]!.full.split(' — ')[0]}` : group.members[0]!.full}
                    style={{
                      width: spanned,
                      flex: 'none',
                      padding: 'var(--space-3) var(--space-2) var(--space-1)',
                      borderRight: '1px solid var(--color-divider)',
                      fontFamily: 'var(--font-heading)',
                      fontSize: 11,
                      letterSpacing: '.07em',
                      textTransform: 'uppercase',
                      color: 'var(--color-neutral-700)',
                      lineHeight: 1.15,
                      wordBreak: 'break-word',
                      textAlign: split ? 'center' : 'left',
                    }}
                  >
                    {group.label}
                  </div>
                );
              })}
              <div
                role="columnheader"
                aria-colindex={columnGroups.length + 3}
                style={{
                  width: TARGET_WIDTH,
                  flex: 'none',
                  padding: 'var(--space-3) var(--space-2) var(--space-1)',
                  fontFamily: 'var(--font-heading)',
                  fontSize: 11,
                  letterSpacing: '.07em',
                  textTransform: 'uppercase',
                  color: 'var(--color-neutral-700)',
                }}
              >
                Target
              </div>
            </div>

            {/*
              The environment row. A column that is not split leaves its slot empty
              rather than repeating the name it already carries above.
            */}
            <div role="row" aria-rowindex={2} style={{ display: 'flex' }}>
              <div
                role="columnheader"
                aria-colindex={1}
                style={{
                  width: NAME_WIDTH,
                  flex: 'none',
                  position: 'sticky',
                  left: 0,
                  zIndex: 13,
                  background: 'var(--color-bg)',
                  borderRight: '1px solid var(--color-divider)',
                  height: 18,
                }}
              />
              <div
                role="columnheader"
                aria-colindex={2}
                style={{
                  width: READY_WIDTH,
                  flex: 'none',
                  borderRight: '1px solid var(--color-divider)',
                }}
              />
              {columns.map((column, index) => (
                <div
                  key={column.key}
                  role="columnheader"
                  aria-colindex={index + 3}
                  title={column.full}
                  style={{
                    width: widthOf(column),
                    flex: 'none',
                    padding: '0 var(--space-2) var(--space-2)',
                    borderRight: '1px solid var(--color-divider)',
                    fontFamily: 'var(--font-heading)',
                    fontSize: 10,
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                    color: 'var(--color-neutral-600)',
                    lineHeight: 1.1,
                    textAlign: column.environment ? 'center' : 'left',
                  }}
                >
                  {column.environment ? column.label : ''}
                </div>
              ))}
              <div
                role="columnheader"
                aria-colindex={columns.length + 3}
                style={{ width: TARGET_WIDTH, flex: 'none' }}
              />
            </div>
          </div>

          {groups.length === 0 ? (
            <div style={{ padding: 'var(--space-6)', fontSize: 13, color: 'var(--color-neutral-600)' }}>
              No modules match those filters.
            </div>
          ) : null}

          {groups.map((group) => {
            const fullyInProd = group.rows.filter((subModule) => subModule.readiness === 100).length;
            return (
              <div key={group.moduleName} role="rowgroup">
                <div
                  role="row"
                  aria-rowindex={++rowIndex}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-2) var(--space-4)',
                    background: 'var(--color-accent-100)',
                    borderBottom: '1px solid var(--color-divider)',
                    position: 'sticky',
                    left: 0,
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontWeight: 600,
                      fontSize: 16,
                      letterSpacing: '.09em',
                      textTransform: 'uppercase',
                    }}
                  >
                    {group.moduleName}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                    {group.rows.length} {group.rows.length === 1 ? 'sub-module' : 'sub-modules'} ·{' '}
                    {fullyInProd} fully in prod
                  </span>
                </div>

                {group.rows.map((subModule) => {
                  const isOpen = expanded.has(subModule.id);
                  const hasSubs = subModule.sub_activities.length > 0;

                  return (
                    <div key={subModule.id}>
                      <div
                        className="hoverable"
                        role="row"
                        aria-rowindex={++rowIndex}
                        aria-expanded={hasSubs ? isOpen : undefined}
                        style={{ display: 'flex', borderBottom: '1px solid var(--color-divider)' }}
                      >
                        <div
                          role="rowheader"
                          aria-colindex={1}
                          style={{
                            width: NAME_WIDTH,
                            flex: 'none',
                            position: 'sticky',
                            left: 0,
                            zIndex: 8,
                            background: 'var(--color-bg)',
                            padding: 'var(--space-2) var(--space-4)',
                            borderRight: '1px solid var(--color-divider)',
                            fontSize: 12,
                            lineHeight: 1.3,
                            wordBreak: 'break-word',
                          }}
                        >
                          <Link href={subModuleHref(subModule.id)} style={{ color: 'inherit' }}>
                            {subModule.name}
                          </Link>
                          <div
                            style={{
                              display: 'flex',
                              gap: 'var(--space-2)',
                              alignItems: 'baseline',
                              fontSize: 11,
                              color: 'var(--color-neutral-600)',
                            }}
                          >
                            <span>{subModule.owner ?? 'unassigned'}</span>
                            {hasSubs ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  // The expander must not also open the module detail.
                                  event.stopPropagation();
                                  toggle(subModule.id);
                                }}
                                style={{
                                  border: 0,
                                  background: 'transparent',
                                  padding: 0,
                                  cursor: 'pointer',
                                  color: 'var(--color-accent-700)',
                                  font: 'inherit',
                                }}
                              >
                                {isOpen ? '−' : '+'} {subModule.sub_activities.length} sub-activities
                              </button>
                            ) : null}
                            {subModule.closed ? (
                              <span style={{ color: 'var(--color-accent-700)' }}>closed</span>
                            ) : null}
                          </div>
                        </div>

                        <div
                          role="gridcell"
                          aria-colindex={2}
                          aria-label={`${subModule.readiness}% ready`}
                          style={{
                            width: READY_WIDTH,
                            flex: 'none',
                            padding: 'var(--space-2)',
                            borderRight: '1px solid var(--color-divider)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--space-2)',
                          }}
                        >
                          <span className="bar" style={{ flex: 1, height: 6 }} aria-hidden>
                            <span style={{ width: `${subModule.readiness}%` }} />
                          </span>
                          <span
                            className="tabular"
                            style={{ fontSize: 11, color: 'var(--color-neutral-700)' }}
                          >
                            {subModule.readiness}
                          </span>
                        </div>

                        {columns.map((column, columnIndex) => {
                          const cell = subModule.cells.find(
                            (candidate) => candidate.column_key === column.key,
                          );
                          if (!cell) return null;
                          return (
                            <div
                              key={column.key}
                              role="gridcell"
                              aria-colindex={columnIndex + 3}
                              style={{
                                width: widthOf(column),
                                flex: 'none',
                                borderRight: `1px solid ${groupEdge(columns, columnIndex)}`,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <StatusMarker
                                cell={cell}
                                column={column}
                                size={24}
                                onClick={() =>
                                  cell.rolled_up ? toggle(subModule.id) : advance(subModule, cell, null)
                                }
                              />
                            </div>
                          );
                        })}

                        <div
                          role="gridcell"
                          aria-colindex={columns.length + 3}
                          style={{
                            width: TARGET_WIDTH,
                            flex: 'none',
                            padding: 'var(--space-2)',
                            fontSize: 12,
                            color: 'var(--color-neutral-600)',
                          }}
                        >
                          {subModule.fni_target_date ?? 'not set'}
                        </div>
                      </div>

                      {isOpen
                        ? subModule.sub_activities.map((subActivity) => (
                            <div
                              key={subActivity.id}
                              role="row"
                              aria-rowindex={++rowIndex}
                              style={{
                                display: 'flex',
                                borderBottom: '1px solid var(--color-divider)',
                                background: 'var(--color-neutral-100)',
                              }}
                            >
                              <div
                                role="rowheader"
                                aria-colindex={1}
                                style={{
                                  width: NAME_WIDTH,
                                  flex: 'none',
                                  position: 'sticky',
                                  left: 0,
                                  zIndex: 8,
                                  background: 'var(--color-neutral-100)',
                                  padding: 'var(--space-1) var(--space-4) var(--space-1) 34px',
                                  borderRight: '1px solid var(--color-divider)',
                                  fontSize: 12,
                                  color: 'var(--color-neutral-700)',
                                  lineHeight: 1.3,
                                  wordBreak: 'break-word',
                                }}
                              >
                                ↳ {subActivity.name}
                              </div>
                              <div
                                role="gridcell"
                                aria-colindex={2}
                                aria-label={`${subActivity.readiness}% ready`}
                                style={{
                                  width: READY_WIDTH,
                                  flex: 'none',
                                  padding: 'var(--space-2)',
                                  borderRight: '1px solid var(--color-divider)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 'var(--space-2)',
                                }}
                              >
                                <span className="bar" style={{ flex: 1, height: 4 }} aria-hidden>
                                  <span style={{ width: `${subActivity.readiness}%` }} />
                                </span>
                                <span
                                  className="tabular"
                                  style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}
                                >
                                  {subActivity.readiness}
                                </span>
                              </div>
                              {columns.map((column, columnIndex) => {
                                const cell = subActivity.cells.find(
                                  (candidate) => candidate.column_key === column.key,
                                );
                                if (!cell) return null;
                                return (
                                  <div
                                    key={column.key}
                                    role="gridcell"
                                    aria-colindex={columnIndex + 3}
                                    style={{
                                      width: widthOf(column),
                                      flex: 'none',
                                      borderRight: `1px solid ${groupEdge(columns, columnIndex)}`,
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                    }}
                                  >
                                    <StatusMarker
                                      cell={cell}
                                      column={column}
                                      size={22}
                                      onClick={() => advance(subModule, cell, subActivity.id)}
                                    />
                                  </div>
                                );
                              })}
                              <div
                                role="gridcell"
                                aria-colindex={columns.length + 3}
                                style={{ width: TARGET_WIDTH, flex: 'none' }}
                              />
                            </div>
                          ))
                        : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 'var(--space-3)', fontSize: 12, color: 'var(--color-neutral-600)' }}>
        {editable
          ? 'Click a cell to advance it through that column’s statuses. A module cell with sub-activities is a roll-up — clicking it opens them.'
          : reasonFor('deliverable.update') + ' — cells are read-only for you.'}{' '}
        A deliverable loaded per environment carries one tick per environment, each recorded
        independently: prod can be ticked with lab blank, because lab was down when the window
        opened. Only the prod tick counts toward readiness.{' '}
        {hiddenEnvironments.length > 0
          ? `${hiddenEnvironments.map((environment) => environment.label).join(' and ')} ${
              hiddenEnvironments.length === 1 ? 'is' : 'are'
            } switched off for this project, so ${
              hiddenEnvironments.length === 1 ? 'its columns are' : 'their columns are'
            } off the grid and out of the maths — nothing recorded against ${
              hiddenEnvironments.length === 1 ? 'it' : 'them'
            } has been deleted. Switch back on under Configure.`
          : 'Environments are switched on and off under Configure.'}
      </div>
    </div>
  );
}

export default function MatrixPage() {
  const { snapshot, can, reasonFor } = useTracker();

  // The grid is generated from the configured columns, so with none there is no grid —
  // checked out here, above `MatrixScreen`'s hooks, rather than short-circuiting inside it.
  if (snapshot.config.columns.length === 0) {
    return (
      <NotConfigured
        projectKey={snapshot.project.key}
        canConfigure={can('project.config')}
        reason={reasonFor('project.config')}
      />
    );
  }

  return (
    <Suspense fallback={null}>
      <MatrixScreen />
    </Suspense>
  );
}
