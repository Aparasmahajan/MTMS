'use client';

import { useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, Chip } from '@/components/primitives';
import { send } from '@/lib/client/api';
import type { DefectPhase, DefectSeverity } from '@/lib/shared/domain';
import { DEFECT_STATUS_ORDER } from '@/lib/shared/domain';
import { formatStamp, type Snapshot } from '@/lib/shared/views';

/**
 * Defects — found while testing on staging or preprod, or during a run on production.
 * Logged against the module it happened on and linked out to its ticket; ticket bodies
 * are never copied in here.
 */

const SEVERITY_STYLE: Record<DefectSeverity, { background: string; color: string }> = {
  High: { background: 'var(--color-text)', color: 'var(--color-bg)' },
  Med: { background: 'var(--color-accent-200)', color: 'var(--color-accent-800)' },
  Low: { background: 'transparent', color: 'var(--color-neutral-700)' },
};

const STATUS_STYLE: Record<string, { background: string; color: string }> = {
  Open: { background: 'var(--color-text)', color: 'var(--color-bg)' },
  Investigating: { background: 'var(--color-accent-200)', color: 'var(--color-accent-800)' },
  Fixed: { background: 'var(--color-accent)', color: 'var(--color-bg)' },
};

export default function DefectsPage() {
  const { snapshot, apply, can, reasonFor, setNotice } = useTracker();
  const { modules, config, defects } = snapshot;

  const [phaseFilter, setPhaseFilter] = useState<'All' | DefectPhase>('All');
  const [moduleId, setModuleId] = useState(modules[0]?.id ?? '');
  const [phase, setPhase] = useState<DefectPhase>('Prod deployment');
  const [childReqId, setChildReqId] = useState('');
  const [ticketKey, setTicketKey] = useState('');
  const [severity, setSeverity] = useState<DefectSeverity>('High');
  const [description, setDescription] = useState('');

  const canCreate = can('defect.create');
  const canTransition = can('defect.transition');

  const shown = defects.filter((defect) => phaseFilter === 'All' || defect.phase === phaseFilter);
  const counts = DEFECT_STATUS_ORDER.map((status) => ({
    label: status,
    value: defects.filter((defect) => defect.status === status).length,
  }));

  async function addDefect() {
    if (!description.trim()) return;
    if (!moduleId) {
      setNotice('There are no modules in this project to log a defect against.');
      return;
    }
    const result = await apply(null, () =>
      send<Snapshot>('/api/v1/defects', 'POST', {
        module_id: moduleId,
        phase,
        ticket_key: ticketKey,
        child_req_id: childReqId,
        severity,
        description,
      }),
    );
    if (result) {
      setDescription('');
      setChildReqId('');
      setTicketKey('');
    }
  }

  function cycle(defectId: string) {
    if (!canTransition) {
      setNotice(reasonFor('defect.transition'));
      return;
    }
    void apply(
      (current) => ({
        ...current,
        defects: current.defects.map((defect) =>
          defect.id === defectId
            ? {
                ...defect,
                status:
                  DEFECT_STATUS_ORDER[
                    (DEFECT_STATUS_ORDER.indexOf(defect.status) + 1) % DEFECT_STATUS_ORDER.length
                  ]!,
              }
            : defect,
        ),
      }),
      () => send<Snapshot>(`/api/v1/defects/${defectId}`, 'PATCH'),
    );
  }

  return (
    <div className="page">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 'var(--space-6)',
          marginBottom: 'var(--space-6)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1>Defects</h1>
          <div className="lede">
            Found while testing on staging or preprod, or during a run on production — logged against
            the module it happened on and linked to its ticket.
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-1)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
            {(['All', ...config.phases] as const).map((option) => (
              <Chip
                key={option}
                label={option}
                active={phaseFilter === option}
                onClick={() => setPhaseFilter(option as 'All' | DefectPhase)}
              />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-6)' }}>
          {counts.map((figure) => (
            <div key={figure.label}>
              <div className="kicker" style={{ fontSize: 11, letterSpacing: '.13em' }}>
                {figure.label}
              </div>
              <div
                className="tabular"
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontWeight: 600,
                  fontSize: 30,
                  lineHeight: 1.1,
                }}
              >
                {figure.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Blueprint style={{ marginBottom: 'var(--space-6)' }}>
        <div className="kicker" style={{ letterSpacing: '.13em', marginBottom: 'var(--space-3)' }}>
          Log a defect
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void addDefect();
          }}
          style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}
        >
          <select
            className="input"
            style={{ width: 300 }}
            value={moduleId}
            onChange={(event) => setModuleId(event.target.value)}
            aria-label="Module"
          >
            {modules.map((module) => (
              <option key={module.id} value={module.id}>
                {module.node_type} · {module.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ width: 160 }}
            value={phase}
            onChange={(event) => setPhase(event.target.value as DefectPhase)}
            aria-label="Phase"
          >
            {config.phases.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <input
            className="input"
            style={{ width: 130 }}
            value={childReqId}
            onChange={(event) => setChildReqId(event.target.value)}
            placeholder="CHILD_REQ_ID"
            aria-label="CHILD_REQ_ID"
          />
          <input
            className="input"
            style={{ width: 180 }}
            value={ticketKey}
            onChange={(event) => setTicketKey(event.target.value)}
            placeholder="Ticket, e.g. CRAUT-2291"
            aria-label="Ticket key"
          />
          <select
            className="input"
            style={{ width: 120 }}
            value={severity}
            onChange={(event) => setSeverity(event.target.value as DefectSeverity)}
            aria-label="Severity"
          >
            {(['High', 'Med', 'Low'] as const).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <input
            className="input"
            style={{ flex: 1, minWidth: 240 }}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What happened on the node"
            aria-label="What happened"
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canCreate}
            title={canCreate ? undefined : reasonFor('defect.create')}
          >
            Add defect
          </button>
        </form>
        {!canCreate ? (
          <div style={{ marginTop: 'var(--space-3)', fontSize: 12, color: 'var(--color-neutral-700)' }}>
            {reasonFor('defect.create')}
          </div>
        ) : null}
      </Blueprint>

      <div className="bordered" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Phase</th>
              <th>Module</th>
              <th>Ticket</th>
              <th>Run</th>
              <th>What happened</th>
              <th>Raised by</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((defect) => (
              <tr key={defect.id}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 12,
                      letterSpacing: '.1em',
                      textTransform: 'uppercase',
                      padding: '1px 7px',
                      border:
                        defect.severity === 'Low' ? '1px solid var(--color-neutral-400)' : 'none',
                      ...SEVERITY_STYLE[defect.severity],
                    }}
                  >
                    {defect.severity}
                  </span>
                </td>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{defect.phase}</td>
                <td style={{ fontSize: 12, wordBreak: 'break-word', maxWidth: 240 }}>
                  {defect.module_label}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {defect.ticket_url ? (
                    <a
                      className="mono"
                      style={{ fontSize: 12 }}
                      href={defect.ticket_url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {defect.ticket_key}
                    </a>
                  ) : (
                    <span className="mono" style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
                      not linked
                    </span>
                  )}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {defect.child_req_id || '—'}
                </td>
                <td style={{ fontSize: 13, textWrap: 'pretty' }}>{defect.description}</td>
                <td style={{ fontSize: 12, color: 'var(--color-neutral-700)', whiteSpace: 'nowrap' }}>
                  {defect.raised_by}, {formatStamp(defect.created_at)}
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => cycle(defect.id)}
                    disabled={!canTransition}
                    title={canTransition ? 'Advance the status' : reasonFor('defect.transition')}
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 13,
                      letterSpacing: '.07em',
                      textTransform: 'uppercase',
                      padding: '2px 8px',
                      border: 0,
                      borderRadius: 0,
                      cursor: canTransition ? 'pointer' : 'not-allowed',
                      opacity: canTransition ? 1 : 0.45,
                      ...STATUS_STYLE[defect.status],
                    }}
                  >
                    {defect.status}
                  </button>
                </td>
              </tr>
            ))}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ fontSize: 13, color: 'var(--color-neutral-600)' }}>
                  No defects in this phase.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 'var(--space-3)', fontSize: 12, color: 'var(--color-neutral-600)' }}>
        Click a status to move it Open → Investigating → Fixed.
      </div>
    </div>
  );
}
