'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, NotConfigured, PageTitle, SectionHeading } from '@/components/primitives';
import { missingLine } from '@/lib/shared/views';

/**
 * Prod readiness — where the project stands, and what is not recorded.
 *
 * Derived entirely from configuration, modules and cells. There is no dashboard data:
 * every figure here is a count over the same projection the matrix renders, which is
 * why a cell click changes this screen too.
 */
export default function DashboardPage() {
  const { snapshot, can, reasonFor, subModuleHref, words } = useTracker();
  const router = useRouter();
  const { sub_modules: subModules, config } = snapshot;

  const stats = useMemo(() => {
    const fullyDone = subModules.filter((subModule) => subModule.readiness === 100).length;
    const notStarted = subModules.filter((subModule) => subModule.readiness === 0).length;
    const blankCells = subModules.reduce((total, subModule) => total + subModule.blank_count, 0);

    return {
      fullyDone,
      notStarted,
      partWay: subModules.length - fullyDone - notStarted,
      blankCells,
      noTarget: subModules.filter((subModule) => !subModule.fni_target_date).length,
      noOwner: subModules.filter((subModule) => !subModule.owner).length,
      noRitm: subModules.filter((subModule) => {
        const cell = subModule.cells.find((entry) => entry.column_key === 'ritm');
        return !cell || cell.status !== 'raised';
      }).length,
    };
  }, [subModules]);

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

  // Counted by the server now, so this screen and the module screen cannot disagree about what
  // "in prod" means. It is the matrix's own definition: every counted deliverable done.
  const byModule = config.modules.filter((entry) => entry.sub_module_count > 0);

  const closest = subModules
    .filter((subModule) => subModule.readiness > 0 && subModule.readiness < 100)
    .sort((a, b) => b.readiness - a.readiness)
    .slice(0, 5);

  const figures = [
    {
      label: 'Fully loaded in prod',
      value: stats.fullyDone,
      note: `of ${subModules.length} ${words.subModule.lowerMany}`,
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
    { count: stats.noTarget, text: `${words.subModule.lowerMany} with no target date for prod loading` },
    { count: stats.noOwner, text: `${words.subModule.lowerMany} with no owner recorded` },
    { count: stats.noRitm, text: `${words.subModule.lowerMany} where no RITM has been raised` },
  ];

  return (
    <div className="page">
      <PageTitle
        kicker={`${snapshot.org.name} / ${snapshot.project.key}`}
        title="Prod readiness"
        lede={`${subModules.length} ${words.subModule.lowerMany} across ${byModule.length} ${words.module.lowerMany}. A ${words.subModule.lower} is one ${words.module.lower} plus one piece of work on it; readiness is measured per deliverable.`}
        actions={
          <>
            <Link href="/matrix" className="btn btn-secondary">
              Open matrix
            </Link>
            <Link href="/library" className="btn btn-primary">
              Add a {words.subModule.lower}
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
          <SectionHeading first>Readiness by {words.module.lower}</SectionHeading>
          <div className="bordered">
            {byModule.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="hoverable"
                onClick={() => router.push(`/modules/${entry.id}`)}
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
                  {entry.name}
                </span>
                <span style={{ width: 96, flex: 'none', fontSize: 12, color: 'var(--color-neutral-600)' }}>
                  {entry.sub_module_count}{' '}
                  {entry.sub_module_count === 1 ? words.subModule.lower : words.subModule.lowerMany}
                </span>
                {/*
                  The question a PM opens this screen to ask. An average is a summary of how far
                  along things are; this is the count of things that are actually finished, and
                  the two move apart exactly when it matters — nineteen activities at 95% is an
                  average that reads well and a release with nothing in production.
                */}
                <span
                  className="tabular"
                  style={{ width: 92, flex: 'none', fontSize: 12, color: 'var(--color-neutral-700)' }}
                  title={`${entry.in_prod} of ${entry.sub_module_count} ${entry.sub_module_count === 1 ? words.subModule.lower : words.subModule.lowerMany} have every counted deliverable loaded in prod`}
                >
                  {entry.in_prod} of {entry.sub_module_count} in prod
                </span>
                <span className="bar" style={{ flex: 1, height: 10 }} aria-hidden>
                  <span style={{ width: `${entry.readiness}%` }} />
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
                  {entry.readiness}%
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
            {closest.map((subModule) => (
              <Link
                key={subModule.id}
                href={subModuleHref(subModule.id)}
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
                    {subModule.module_name}
                  </span>
                  <span style={{ flex: 1, fontSize: 13, lineHeight: 1.3, wordBreak: 'break-word' }}>
                    {subModule.name}
                  </span>
                  <span
                    className="tabular"
                    style={{ fontFamily: 'var(--font-heading)', fontSize: 16, flex: 'none' }}
                  >
                    {subModule.readiness}%
                  </span>
                </div>
                <div style={{ marginTop: 'var(--space-1)', fontSize: 12, color: 'var(--color-neutral-600)' }}>
                  {missingLine(subModule.missing)}
                </div>
              </Link>
            ))}
          </div>

          {/*
            The recent-changes panel that sat here was dropped on 15 Sept. It duplicated the
            Audit screen in six rows and could not say enough to be useful — the link is kept
            because "where did the feed go" is the obvious next question.
          */}
          {can('admin.audit.view') ? (
            <div style={{ marginTop: 'var(--space-6)', fontSize: 12 }}>
              <Link href="/audit" style={{ color: 'var(--color-neutral-700)' }}>
                See every change →
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
