'use client';

import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, PageTitle, SectionHeading } from '@/components/primitives';
import type { DriftVerdict } from '@/lib/shared/domain';

/**
 * Drift.
 *
 * "Loaded in prod" is only true if the bytes on prod are the ones that passed preprod.
 * The same file exists in many places with different contents, compiled artifacts go
 * stale against source, and the deployed copy drifts from the repo copy — so identity
 * here is content hash, never path.
 *
 * The hashes come from an environment agent; the tracker compares them and nothing
 * more. Until that agent reports, these are the last values it recorded.
 */

const VERDICT_STYLE: Record<DriftVerdict, { background: string; color: string }> = {
  'In step': { background: 'var(--color-accent-200)', color: 'var(--color-accent-800)' },
  'Prod behind': { background: 'var(--color-text)', color: 'var(--color-bg)' },
  'Patched in place': { background: 'var(--color-text)', color: 'var(--color-bg)' },
  'Never verified': { background: 'var(--color-text)', color: 'var(--color-bg)' },
};

export default function DriftPage() {
  const { snapshot } = useTracker();
  const { rows, warnings } = snapshot.drift;

  // The gate is per project and, like every other derived number here, computed from
  // the same projection the matrix renders.
  const worstReadiness = snapshot.modules.length
    ? Math.min(...snapshot.modules.map((module) => module.readiness))
    : 0;
  const mismatches = rows.filter((row) => row.verdict !== 'In step').length;

  const gate = [
    {
      text: 'Every counted deliverable is Loaded in prod',
      by: `lowest module ${worstReadiness}%`,
      passed: worstReadiness === 100,
    },
    {
      text: 'Preprod hash matches the prod hash',
      by: `${mismatches} ${mismatches === 1 ? 'mismatch' : 'mismatches'}`,
      passed: mismatches === 0,
    },
    { text: 'FNI final submission complete', by: 'pending', passed: false },
    { text: 'Node access granted', by: 'pending', passed: false },
  ];
  const blocked = gate.filter((entry) => !entry.passed).length;

  return (
    <div className="page page-narrow">
      <PageTitle
        title="Drift"
        lede='"Loaded in prod" is only true if the bytes on prod are the ones that passed preprod. This compares them.'
      />

      <div className="bordered" style={{ overflowX: 'auto', marginBottom: 'var(--space-8)' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Deliverable</th>
              <th>Scope</th>
              <th>Repo</th>
              <th>Lab</th>
              <th>Preprod</th>
              <th>Prod</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
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
                  <div style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{row.cadence}</div>
                </td>
                <td>
                  <span className="tag tag-outline">{row.scope}</span>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {row.repo}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {row.lab}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {row.preprod}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {row.prod}
                </td>
                <td>
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 13,
                      letterSpacing: '.07em',
                      textTransform: 'uppercase',
                      padding: '2px 8px',
                      ...VERDICT_STYLE[row.verdict],
                    }}
                  >
                    {row.verdict}
                  </span>
                </td>
              </tr>
            ))}
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
            {warnings.map((warning) => (
              <div
                key={warning.id}
                style={{
                  padding: 'var(--space-3) var(--space-4)',
                  borderBottom: '1px solid var(--color-divider)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)' }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 12,
                      letterSpacing: '.1em',
                      textTransform: 'uppercase',
                      padding: '1px 7px',
                      background: 'var(--color-text)',
                      color: 'var(--color-bg)',
                      flex: 'none',
                    }}
                  >
                    {warning.severity}
                  </span>
                  <span style={{ flex: 1, fontSize: 13, lineHeight: 1.35, textWrap: 'pretty' }}>
                    {warning.text}
                  </span>
                </div>
                <div style={{ marginTop: 'var(--space-1)', fontSize: 12, color: 'var(--color-neutral-600)' }}>
                  {warning.where}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionHeading first>Promotion gate</SectionHeading>
          <Blueprint>
            <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 'var(--space-4)', textWrap: 'pretty' }}>
              Promotion copies hashes; it never rebuilds. Gates are set per project.
            </div>
            {gate.map((entry) => (
              <div
                key={entry.text}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-2) 0',
                  borderTop: '1px solid var(--color-divider)',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 14,
                    height: 14,
                    flex: 'none',
                    border: '1px solid var(--color-neutral-500)',
                    background: entry.passed ? 'var(--color-accent)' : 'transparent',
                  }}
                />
                <span style={{ flex: 1, fontSize: 13 }}>{entry.text}</span>
                <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{entry.by}</span>
              </div>
            ))}

            <button
              type="button"
              disabled
              title={`Blocked by ${blocked} ${blocked === 1 ? 'gate' : 'gates'}`}
              style={{
                display: 'block',
                width: '100%',
                marginTop: 'var(--space-6)',
                padding: 'var(--space-2) var(--space-4)',
                textAlign: 'center',
                background: 'var(--color-neutral-300)',
                color: 'var(--color-neutral-700)',
                border: 0,
                borderRadius: 0,
                fontFamily: 'var(--font-heading)',
                fontSize: 15,
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                cursor: 'not-allowed',
              }}
            >
              {blocked === 0
                ? 'Promote'
                : `Promote — blocked by ${blocked} ${blocked === 1 ? 'gate' : 'gates'}`}
            </button>
          </Blueprint>

          <div style={{ marginTop: 'var(--space-3)', fontSize: 12, color: 'var(--color-neutral-600)', textWrap: 'pretty' }}>
            Hashes are reported by an environment agent, which is not built yet. It has to respect
            the platform as it is: Java 8 and Python 2 on the servers, <span className="mono">.packinglist</span>{' '}
            as the source of truth for what deploys, strict YAML binding against the compiled bean,
            and a ~96 KB inline transport ceiling above which files go over SFTP.
          </div>
        </div>
      </div>
    </div>
  );
}
