'use client';

import Link from 'next/link';
import { useTracker } from '@/components/TrackerProvider';
import { PageTitle } from '@/components/primitives';
import { missingLine } from '@/lib/shared/views';

/**
 * Pipeline — the same modules, placed by how far their deliverables have got.
 * Stage assignment is derived from readiness, so adding a stage on the Configure
 * screen re-buckets every module without touching any data.
 */
export default function PipelinePage() {
  const { snapshot, moduleHref } = useTracker();
  const { stages } = snapshot.config;

  if (stages.length === 0) {
    return (
      <div className="page-full">
        <PageTitle title="Pipeline" lede="No stages are configured for this project yet." />
        <Link href="/configure" className="btn btn-secondary">
          Configure stages
        </Link>
      </div>
    );
  }

  return (
    <div className="page-full">
      <PageTitle
        title="Pipeline"
        lede="The same modules, placed by how far their deliverables have got. Stage names come from project configuration."
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))`,
          gap: 1,
          background: 'var(--color-divider)',
          border: '1px solid var(--color-divider)',
          overflowX: 'auto',
        }}
      >
        {stages.map((stage, index) => {
          const items = snapshot.modules.filter((module) => module.stage_index === index);
          return (
            <div key={stage.id} style={{ background: 'var(--color-bg)', paddingBottom: 'var(--space-4)', minWidth: 160 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-3)',
                  borderBottom: '1px solid var(--color-divider)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 600,
                    fontSize: 14,
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                    lineHeight: 1.15,
                  }}
                >
                  {stage.label}
                </span>
                <span className="mono" style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
                  {items.length}
                </span>
              </div>

              <div
                style={{
                  padding: 'var(--space-3) var(--space-3) 0',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                }}
              >
                {items.map((module) => (
                  <Link
                    key={module.id}
                    href={moduleHref(module.id)}
                    style={{
                      border: '1px solid var(--color-neutral-400)',
                      padding: 'var(--space-3)',
                      color: 'inherit',
                      display: 'block',
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
                      <span className="tag tag-accent">{module.node_type}</span>
                      <span
                        className="tabular"
                        style={{ fontFamily: 'var(--font-heading)', fontSize: 13 }}
                      >
                        {module.readiness}%
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: 'var(--space-2)',
                        fontSize: 12,
                        lineHeight: 1.3,
                        wordBreak: 'break-word',
                      }}
                    >
                      {module.name}
                    </div>
                    {module.missing.length ? (
                      <div
                        style={{
                          marginTop: 'var(--space-2)',
                          paddingTop: 'var(--space-2)',
                          borderTop: '1px dotted var(--color-neutral-400)',
                          fontSize: 11,
                          lineHeight: 1.3,
                          color: 'var(--color-neutral-700)',
                        }}
                      >
                        {missingLine(module.missing)}
                      </div>
                    ) : null}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
