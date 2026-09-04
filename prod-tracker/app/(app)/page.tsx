'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, NotConfigured, PageTitle, SectionHeading } from '@/components/primitives';
import { formatStamp, missingLine } from '@/lib/shared/views';

/**
 * Prod readiness — where the project stands, and what is not recorded.
 *
 * Derived entirely from configuration, modules and cells. There is no dashboard data:
 * every figure here is a count over the same projection the matrix renders, which is
 * why a cell click changes this screen too.
 */
export default function DashboardPage() {
  const { snapshot, can, reasonFor } = useTracker();
  const router = useRouter();
  const { modules, config } = snapshot;

  const stats = useMemo(() => {
    const fullyDone = modules.filter((module) => module.readiness === 100).length;
    const notStarted = modules.filter((module) => module.readiness === 0).length;
    const blankCells = modules.reduce((total, module) => total + module.blank_count, 0);

    return {
      fullyDone,
      notStarted,
      partWay: modules.length - fullyDone - notStarted,
      blankCells,
      noTarget: modules.filter((module) => !module.fni_target_date).length,
      noOwner: modules.filter((module) => !module.owner).length,
      noRitm: modules.filter((module) => {
        const cell = module.cells.find((entry) => entry.column_key === 'ritm');
        return !cell || cell.status !== 'raised';
      }).length,
    };
  }, [modules]);

  // Every figure below counts over the deliverable columns. With none configured they
  // would all read zero, which looks like a project in trouble rather than one not yet
  // set up — so say which it is.
  if (config.columns.length === 0) {
    return (
      <NotConfigured
        projectKey={snapshot.project.key}
        canConfigure={can('project.config')}
        reason={reasonFor('project.config')}
      />
    );
  }

  const byNodeType = config.node_types
    .map((nodeType) => {
      const rows = modules.filter((module) => module.node_type === nodeType);
      const average = rows.length
        ? Math.round(rows.reduce((total, module) => total + module.readiness, 0) / rows.length)
        : 0;
      return { nodeType, count: rows.length, average };
    })
    .filter((entry) => entry.count > 0);

  const closest = modules
    .filter((module) => module.readiness > 0 && module.readiness < 100)
    .sort((a, b) => b.readiness - a.readiness)
    .slice(0, 5);

  const figures = [
    {
      label: 'Fully loaded in prod',
      value: stats.fullyDone,
      note: `of ${modules.length} modules`,
      href: '/matrix?ready=Loaded+in+prod',
    },
    {
      label: 'Part way',
      value: stats.partWay,
      note: 'at least one deliverable short',
      href: '/matrix?ready=Partial',
    },
    {
      label: 'Not started',
      value: stats.notStarted,
      note: 'nothing in prod yet',
      href: '/matrix?ready=Not+started',
    },
    {
      label: 'Blank cells',
      value: stats.blankCells,
      note: 'no status recorded either way',
      href: '/matrix?ready=Has+blanks',
    },
  ];

  const gaps = [
    { count: stats.blankCells, text: 'cells with no status at all, so readiness cannot be trusted' },
    { count: stats.noTarget, text: 'modules with no target date for prod loading' },
    { count: stats.noOwner, text: 'modules with no owner recorded' },
    { count: stats.noRitm, text: 'modules where no RITM has been raised' },
  ];

  return (
    <div className="page">
      <PageTitle
        kicker={`${snapshot.org.name} / ${snapshot.project.key}`}
        title="Prod readiness"
        lede={`${modules.length} modules across ${byNodeType.length} node types. A module is a node type plus an activity; readiness is measured per deliverable.`}
        actions={
          <>
            <Link href="/matrix" className="btn btn-secondary">
              Open matrix
            </Link>
            <Link href="/library" className="btn btn-primary">
              Add a module
            </Link>
          </>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 1,
          background: 'var(--color-divider)',
          border: '1px solid var(--color-divider)',
          marginBottom: 'var(--space-8)',
        }}
      >
        {figures.map((figure) => (
          <button
            key={figure.label}
            type="button"
            className="hoverable"
            onClick={() => router.push(figure.href)}
            style={{
              background: 'var(--color-bg)',
              padding: 'var(--space-6)',
              border: 0,
              textAlign: 'left',
              color: 'inherit',
            }}
          >
            <div className="kicker" style={{ letterSpacing: '.13em' }}>
              {figure.label}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 'var(--space-3)',
                marginTop: 'var(--space-1)',
              }}
            >
              <span
                className="tabular"
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontWeight: 600,
                  fontSize: 44,
                  lineHeight: 1,
                }}
              >
                {figure.value}
              </span>
              <span style={{ fontSize: 13, color: 'var(--color-neutral-700)', textWrap: 'pretty' }}>
                {figure.note}
              </span>
            </div>
          </button>
        ))}
      </div>

      <div
        className="split"
        style={{
          display: 'grid',
          gridTemplateColumns: '1.25fr 1fr',
          gap: 'var(--space-8)',
          alignItems: 'start',
        }}
      >
        <div>
          <SectionHeading first>Readiness by node type</SectionHeading>
          <div className="bordered">
            {byNodeType.map((entry) => (
              <button
                key={entry.nodeType}
                type="button"
                className="hoverable"
                onClick={() => router.push(`/matrix?node=${encodeURIComponent(entry.nodeType)}`)}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  gap: 'var(--space-4)',
                  padding: 'var(--space-3) var(--space-4)',
                  borderBottom: '1px solid var(--color-divider)',
                  border: 0,
                  background: 'transparent',
                  textAlign: 'left',
                  color: 'inherit',
                }}
              >
                <span
                  style={{
                    width: 56,
                    flex: 'none',
                    fontFamily: 'var(--font-heading)',
                    fontSize: 17,
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  {entry.nodeType}
                </span>
                <span style={{ width: 74, flex: 'none', fontSize: 12, color: 'var(--color-neutral-600)' }}>
                  {entry.count} {entry.count === 1 ? 'module' : 'modules'}
                </span>
                <span className="bar" style={{ flex: 1, height: 10 }} aria-hidden>
                  <span style={{ width: `${entry.average}%` }} />
                </span>
                <span
                  className="tabular"
                  style={{
                    width: 44,
                    flex: 'none',
                    textAlign: 'right',
                    fontFamily: 'var(--font-heading)',
                    fontSize: 16,
                  }}
                >
                  {entry.average}%
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <SectionHeading first>Nothing recorded</SectionHeading>
          <Blueprint>
            <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 'var(--space-4)', textWrap: 'pretty' }}>
              A blank cell is not a status. These are the gaps in the sheet itself — the fastest thing
              to fix, because nobody knows whether the work is done or not.
            </div>
            {gaps.map((gap) => (
              <div
                key={gap.text}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-2) 0',
                  borderTop: '1px solid var(--color-divider)',
                }}
              >
                <span
                  className="tabular"
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 600,
                    fontSize: 20,
                    width: 40,
                    flex: 'none',
                  }}
                >
                  {gap.count}
                </span>
                <span style={{ flex: 1, fontSize: 13, textWrap: 'pretty' }}>{gap.text}</span>
              </div>
            ))}
          </Blueprint>

          <SectionHeading>Closest to prod</SectionHeading>
          <div className="bordered">
            {closest.length === 0 ? (
              <div style={{ padding: 'var(--space-4)', fontSize: 13, color: 'var(--color-neutral-600)' }}>
                Nothing is part way — every module is either finished or not started.
              </div>
            ) : null}
            {closest.map((module) => (
              <Link
                key={module.id}
                href={`/modules/${module.id}`}
                className="hoverable"
                style={{
                  display: 'block',
                  padding: 'var(--space-3) var(--space-4)',
                  borderBottom: '1px solid var(--color-divider)',
                  color: 'inherit',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)' }}>
                  <span className="tag tag-accent" style={{ flex: 'none' }}>
                    {module.node_type}
                  </span>
                  <span style={{ flex: 1, fontSize: 13, lineHeight: 1.3, wordBreak: 'break-word' }}>
                    {module.name}
                  </span>
                  <span
                    className="tabular"
                    style={{ fontFamily: 'var(--font-heading)', fontSize: 16, flex: 'none' }}
                  >
                    {module.readiness}%
                  </span>
                </div>
                <div style={{ marginTop: 'var(--space-1)', fontSize: 12, color: 'var(--color-neutral-600)' }}>
                  {missingLine(module.missing)}
                </div>
              </Link>
            ))}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
            }}
          >
            <SectionHeading>Recent changes</SectionHeading>
            {can('admin.audit.view') ? (
              <Link
                href="/audit"
                style={{ fontSize: 12, color: 'var(--color-neutral-700)', flex: 'none' }}
              >
                See every change →
              </Link>
            ) : null}
          </div>
          <div className="bordered">
            {snapshot.audit.slice(0, 6).map((entry) => (
              <div
                key={entry.id}
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
                    width: 76,
                    flex: 'none',
                  }}
                >
                  {entry.label}
                </span>
                <span style={{ flex: 1, color: 'var(--color-neutral-700)', wordBreak: 'break-word' }}>
                  {entry.what}
                </span>
                <span style={{ color: 'var(--color-neutral-600)', flex: 'none' }}>
                  {entry.who}, {formatStamp(entry.at)}
                </span>
              </div>
            ))}
            {snapshot.audit.length === 0 ? (
              <div style={{ padding: 'var(--space-4)', fontSize: 13, color: 'var(--color-neutral-600)' }}>
                Nothing has been changed yet.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
