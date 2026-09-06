'use client';

import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, PageTitle, SectionHeading } from '@/components/primitives';
import { send } from '@/lib/client/api';
import type { DriftVerdict } from '@/lib/shared/domain';
import { formatStamp, type Snapshot } from '@/lib/shared/views';

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
 */

const VERDICT_STYLE: Record<DriftVerdict, { background: string; color: string }> = {
  'In step': { background: 'var(--color-accent-200)', color: 'var(--color-accent-800)' },
  'Prod behind': { background: 'var(--color-text)', color: 'var(--color-bg)' },
  'Patched in place': { background: 'var(--color-text)', color: 'var(--color-bg)' },
  'Never verified': { background: 'var(--color-text)', color: 'var(--color-bg)' },
  'Not deployed': { background: 'var(--color-text)', color: 'var(--color-bg)' },
};

const ENVIRONMENTS = ['repo', 'lab', 'preprod', 'prod'] as const;

export default function DriftPage() {
  const { snapshot, apply, can, reasonFor, setNotice } = useTracker();
  const { rows, warnings, gate, reports, promotions } = snapshot.drift;
  const canPromote = can('prod.confirm');

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

  const promoteDisabled = !canPromote || !gate.can_promote;
  const promoteReason = !canPromote
    ? reasonFor('prod.confirm')
    : gate.can_promote
      ? ''
      : `Blocked — ${gate.checks.filter((check) => !check.passed).map((check) => check.text).join('; ')}`;

  return (
    <div className="page page-narrow">
      <PageTitle
        title="Drift"
        lede='"Loaded in prod" is only true if the bytes on prod are the ones that passed preprod. This compares them, by content hash.'
      />

      {/* When each environment was last looked at. An agent that stopped reporting looks
          exactly like an environment that stopped changing, so say which it is. */}
      <div
        className="bordered"
        style={{ display: 'flex', flexWrap: 'wrap', marginBottom: 'var(--space-6)' }}
      >
        {reports.map((report) => (
          <div
            key={report.environment}
            style={{
              flex: '1 1 160px',
              padding: 'var(--space-3) var(--space-4)',
              borderRight: '1px solid var(--color-divider)',
            }}
          >
            <div className="kicker" style={{ letterSpacing: '.11em' }}>
              {report.environment}
            </div>
            <div style={{ fontSize: 13, marginTop: 2 }}>
              {report.at ? (
                <>
                  {report.observation_count} {report.observation_count === 1 ? 'file' : 'files'} ·{' '}
                  {formatStamp(report.at)}
                </>
              ) : (
                <span style={{ color: 'var(--color-neutral-600)' }}>never reported</span>
              )}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}>
              {report.agent}
            </div>
          </div>
        ))}
      </div>

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
                  <div style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
                    {row.code_layer} · {row.cadence}
                  </div>
                  {row.paths.map((path) => (
                    <div
                      key={path}
                      className="mono"
                      style={{ fontSize: 11, color: 'var(--color-neutral-600)', wordBreak: 'break-all' }}
                    >
                      {path}
                    </div>
                  ))}
                </td>
                <td>
                  <span className="tag tag-outline">{row.scope}</span>
                </td>
                {ENVIRONMENTS.map((environment) => {
                  const full = row.full_hashes[environment];
                  return (
                    <td
                      key={environment}
                      className="mono"
                      style={{ fontSize: 12, color: full ? undefined : 'var(--color-neutral-600)' }}
                      // The six characters are for reading; the identity is the whole hash.
                      title={full ? `sha256 ${full}` : `no hash reported from ${environment}`}
                    >
                      {row[environment]}
                    </td>
                  );
                })}
                <td>
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 13,
                      letterSpacing: '.07em',
                      textTransform: 'uppercase',
                      padding: '2px 8px',
                      whiteSpace: 'nowrap',
                      ...VERDICT_STYLE[row.verdict],
                    }}
                  >
                    {row.verdict}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ fontSize: 13, color: 'var(--color-neutral-600)' }}>
                  No deliverables are set up for hash tracking on this project.
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
                      background:
                        warning.severity === 'High' ? 'var(--color-text)' : 'var(--color-accent-200)',
                      color:
                        warning.severity === 'High' ? 'var(--color-bg)' : 'var(--color-accent-800)',
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
            {warnings.length === 0 ? (
              <div style={{ padding: 'var(--space-4)', fontSize: 13, color: 'var(--color-neutral-600)' }}>
                Nothing outstanding — every deliverable matches across the environments that
                have reported.
              </div>
            ) : null}
          </div>
        </div>

        <div>
          <SectionHeading first>Promotion gate</SectionHeading>
          <Blueprint>
            <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 'var(--space-4)', textWrap: 'pretty' }}>
              Promotion copies hashes; it never rebuilds. Recording one does not change prod —
              it records the exact bytes that should now be there, and stays unconfirmed until
              an agent reports them back.
            </div>

            {gate.checks.map((check) => (
              <div
                key={check.text}
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
                    background: check.passed ? 'var(--color-accent)' : 'transparent',
                  }}
                />
                <span style={{ flex: 1, fontSize: 13 }}>{check.text}</span>
                <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{check.detail}</span>
              </div>
            ))}

            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={promoteDisabled}
              title={promoteReason || undefined}
              onClick={() => void promote()}
              style={{ marginTop: 'var(--space-6)' }}
            >
              {gate.label}
            </button>

            {promoteReason ? (
              <div
                style={{
                  marginTop: 'var(--space-3)',
                  fontSize: 12,
                  color: 'var(--color-neutral-700)',
                  textWrap: 'pretty',
                }}
              >
                {promoteReason}
              </div>
            ) : null}
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

          <div style={{ marginTop: 'var(--space-3)', fontSize: 12, color: 'var(--color-neutral-600)', textWrap: 'pretty' }}>
            Hashes come from <span className="mono">agent/report_hashes.py</span>, which runs on
            each environment and posts to <span className="mono">/api/v1/drift/reports</span>. It
            is written for Python 2.6+ and reads <span className="mono">.packinglist</span> for
            what actually deploys, because a file in the repo and absent from that list never
            reaches a server.
          </div>
        </div>
      </div>
    </div>
  );
}
