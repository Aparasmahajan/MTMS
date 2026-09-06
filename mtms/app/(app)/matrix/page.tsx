'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTracker } from '@/components/TrackerProvider';
import { Chip, NotConfigured, StatusMarker } from '@/components/primitives';
import { send } from '@/lib/client/api';
import { optimisticAdvance } from '@/lib/client/optimistic';
import { STATUS_VOCABULARY, TONE_STYLE } from '@/lib/shared/vocabulary';
import type { CellView, ModuleView, Snapshot } from '@/lib/shared/views';

/**
 * The module matrix — the spreadsheet, made editable.
 *
 * Geometry is fixed so the sticky first column and sticky header row line up: a 326px
 * module cell, an 82px readiness cell, one 76px cell per configured column, and a 96px
 * target cell. The container's min-width is the sum, so both axes scroll.
 */

const NAME_WIDTH = 326;
const READY_WIDTH = 82;
const CELL_WIDTH = 76;
const TARGET_WIDTH = 96;

const READINESS_FILTERS = ['All', 'Loaded in prod', 'Partial', 'Not started', 'Has blanks'] as const;
type ReadinessFilter = (typeof READINESS_FILTERS)[number];

function MatrixScreen() {
  const { snapshot, apply, can, reasonFor, setNotice, moduleHref } = useTracker();
  const router = useRouter();
  const params = useSearchParams();

  const nodeFilter = params.get('node') ?? 'All';
  const readyParam = params.get('ready') ?? 'All';
  const readyFilter: ReadinessFilter = (READINESS_FILTERS as readonly string[]).includes(readyParam)
    ? (readyParam as ReadinessFilter)
    : 'All';

  // Expansion is local UI state — it is not worth a round trip or a URL.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { columns } = snapshot.config;
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
    let modules = snapshot.modules;
    if (nodeFilter !== 'All') modules = modules.filter((module) => module.node_type === nodeFilter);
    if (readyFilter === 'Loaded in prod') modules = modules.filter((module) => module.readiness === 100);
    else if (readyFilter === 'Partial')
      modules = modules.filter((module) => module.readiness > 0 && module.readiness < 100);
    else if (readyFilter === 'Not started') modules = modules.filter((module) => module.readiness === 0);
    else if (readyFilter === 'Has blanks') modules = modules.filter((module) => module.blank_count > 0);
    return modules;
  }, [snapshot.modules, nodeFilter, readyFilter]);

  const groups = snapshot.config.node_types
    .map((nodeType) => ({
      nodeType,
      rows: shown.filter((module) => module.node_type === nodeType),
    }))
    .filter((group) => group.rows.length > 0);

  function toggle(moduleId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  }

  function advance(module: ModuleView, cell: CellView, subactivityId: string | null) {
    if (!editable) {
      setNotice(reasonFor('deliverable.update'));
      return;
    }
    if (module.closed) {
      setNotice('This module is closed. Reopen it from the module screen before changing a cell.');
      return;
    }
    void apply(
      (current) =>
        optimisticAdvance(
          current,
          module.id,
          subactivityId,
          cell.column_key,
          current.me.display_name,
        ),
      () =>
        send<Snapshot>('/api/v1/cells', 'PATCH', {
          module_id: module.id,
          subactivity_id: subactivityId,
          column_key: cell.column_key,
        }),
    );
  }

  const minWidth = NAME_WIDTH + READY_WIDTH + TARGET_WIDTH + columns.length * CELL_WIDTH;

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
          <h1>Module matrix</h1>
          <div className="lede">
            One row per module — a node type plus an activity. Open a module to reach its
            subactivities; a module cell is a roll-up of them. Every change is stamped with who and
            when.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-6)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <div className="kicker" style={{ fontSize: 11, marginBottom: 'var(--space-1)' }}>
              Node type
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
              {['All', ...snapshot.config.node_types].map((nodeType) => (
                <Chip
                  key={nodeType}
                  label={nodeType}
                  active={nodeFilter === nodeType}
                  onClick={() => setFilter({ node: nodeType })}
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
        {(['prod', 'lab', 'notloaded', 'blank'] as const).map((key) => {
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
        <div style={{ minWidth }}>
          {/* Header row — sticky top, with the first cell sticky in both axes. */}
          <div
            style={{
              display: 'flex',
              position: 'sticky',
              top: 0,
              zIndex: 12,
              background: 'var(--color-bg)',
              borderBottom: '1px solid var(--color-neutral-400)',
            }}
          >
            <div
              className="kicker"
              style={{
                width: NAME_WIDTH,
                flex: 'none',
                position: 'sticky',
                left: 0,
                zIndex: 13,
                background: 'var(--color-bg)',
                padding: 'var(--space-3) var(--space-4)',
                borderRight: '1px solid var(--color-divider)',
                letterSpacing: '.11em',
              }}
            >
              Module — node + activity
            </div>
            <div
              className="kicker"
              style={{
                width: READY_WIDTH,
                flex: 'none',
                padding: 'var(--space-3) var(--space-2)',
                borderRight: '1px solid var(--color-divider)',
                letterSpacing: '.08em',
              }}
            >
              Ready
            </div>
            {columns.map((column) => (
              <div
                key={column.key}
                title={column.full}
                style={{
                  width: CELL_WIDTH,
                  flex: 'none',
                  padding: 'var(--space-3) var(--space-2)',
                  borderRight: '1px solid var(--color-divider)',
                  fontFamily: 'var(--font-heading)',
                  fontSize: 11,
                  letterSpacing: '.07em',
                  textTransform: 'uppercase',
                  color: 'var(--color-neutral-700)',
                  lineHeight: 1.15,
                  wordBreak: 'break-word',
                }}
              >
                {column.label}
              </div>
            ))}
            <div
              style={{
                width: TARGET_WIDTH,
                flex: 'none',
                padding: 'var(--space-3) var(--space-2)',
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

          {groups.length === 0 ? (
            <div style={{ padding: 'var(--space-6)', fontSize: 13, color: 'var(--color-neutral-600)' }}>
              No modules match those filters.
            </div>
          ) : null}

          {groups.map((group) => {
            const fullyInProd = group.rows.filter((module) => module.readiness === 100).length;
            return (
              <div key={group.nodeType}>
                <div
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
                    {group.nodeType}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                    {group.rows.length} {group.rows.length === 1 ? 'module' : 'modules'} ·{' '}
                    {fullyInProd} fully in prod
                  </span>
                </div>

                {group.rows.map((module) => {
                  const isOpen = expanded.has(module.id);
                  const hasSubs = module.subactivities.length > 0;

                  return (
                    <div key={module.id}>
                      <div className="hoverable" style={{ display: 'flex', borderBottom: '1px solid var(--color-divider)' }}>
                        <div
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
                          <Link href={moduleHref(module.id)} style={{ color: 'inherit' }}>
                            {module.name}
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
                            <span>{module.owner ?? 'unassigned'}</span>
                            {hasSubs ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  // The expander must not also open the module detail.
                                  event.stopPropagation();
                                  toggle(module.id);
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
                                {isOpen ? '−' : '+'} {module.subactivities.length} subactivities
                              </button>
                            ) : null}
                            {module.closed ? (
                              <span style={{ color: 'var(--color-accent-700)' }}>closed</span>
                            ) : null}
                          </div>
                        </div>

                        <div
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
                            <span style={{ width: `${module.readiness}%` }} />
                          </span>
                          <span
                            className="tabular"
                            style={{ fontSize: 11, color: 'var(--color-neutral-700)' }}
                          >
                            {module.readiness}
                          </span>
                        </div>

                        {module.cells.map((cell) => {
                          const column = columns.find((candidate) => candidate.key === cell.column_key);
                          if (!column) return null;
                          return (
                            <div
                              key={cell.column_key}
                              style={{
                                width: CELL_WIDTH,
                                flex: 'none',
                                borderRight: '1px solid var(--color-divider)',
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
                                  cell.rolled_up ? toggle(module.id) : advance(module, cell, null)
                                }
                              />
                            </div>
                          );
                        })}

                        <div
                          style={{
                            width: TARGET_WIDTH,
                            flex: 'none',
                            padding: 'var(--space-2)',
                            fontSize: 12,
                            color: 'var(--color-neutral-600)',
                          }}
                        >
                          {module.fni_target_date ?? 'not set'}
                        </div>
                      </div>

                      {isOpen
                        ? module.subactivities.map((subactivity) => (
                            <div
                              key={subactivity.id}
                              style={{
                                display: 'flex',
                                borderBottom: '1px solid var(--color-divider)',
                                background: 'var(--color-neutral-100)',
                              }}
                            >
                              <div
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
                                ↳ {subactivity.name}
                              </div>
                              <div
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
                                  <span style={{ width: `${subactivity.readiness}%` }} />
                                </span>
                                <span
                                  className="tabular"
                                  style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}
                                >
                                  {subactivity.readiness}
                                </span>
                              </div>
                              {subactivity.cells.map((cell) => {
                                const column = columns.find(
                                  (candidate) => candidate.key === cell.column_key,
                                );
                                if (!column) return null;
                                return (
                                  <div
                                    key={cell.column_key}
                                    style={{
                                      width: CELL_WIDTH,
                                      flex: 'none',
                                      borderRight: '1px solid var(--color-divider)',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                    }}
                                  >
                                    <StatusMarker
                                      cell={cell}
                                      column={column}
                                      size={22}
                                      onClick={() => advance(module, cell, subactivity.id)}
                                    />
                                  </div>
                                );
                              })}
                              <div style={{ width: TARGET_WIDTH, flex: 'none' }} />
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
          ? 'Click a cell to advance it through that column’s statuses. A module cell with subactivities is a roll-up — clicking it opens them.'
          : reasonFor('deliverable.update') + ' — cells are read-only for you.'}{' '}
        Target date and owner were not in the DevOps sheet; both are columns here waiting to be
        filled.
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
