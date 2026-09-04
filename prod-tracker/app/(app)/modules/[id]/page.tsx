'use client';

import { useState } from 'react';
import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, SectionHeading, StatusMarker } from '@/components/primitives';
import { send } from '@/lib/client/api';
import { optimisticAdvance } from '@/lib/client/optimistic';
import { toneOf, TONE_STYLE } from '@/lib/shared/vocabulary';
import { cellPresentation, formatStamp, type ModuleView, type Snapshot } from '@/lib/shared/views';

/**
 * The module screen — everything about one module, and the only place the FNI chain
 * can be closed.
 *
 * The blockers computed here are for the disabled control's explanation only. The
 * server recomputes them from the store before it will close anything.
 */

/** The quiet inline actions on a subactivity row — same weight as "remove" on a link. */
function subactivityActionStyle(enabled: boolean) {
  return {
    fontSize: 12,
    color: 'var(--color-neutral-600)',
    border: 0,
    background: 'transparent',
    cursor: enabled ? 'pointer' : 'not-allowed',
    padding: 0,
  } as const;
}

function blockersFor(module: ModuleView): string[] {
  const blockers: string[] = [];
  if (module.readiness !== 100) {
    blockers.push('DevOps has not confirmed every deliverable loaded in prod');
  }
  const fni = module.cells.find((cell) => cell.column_key === 'fni');
  if (!fni || toneOf(fni.status) !== 'done') blockers.push('FNI final submission is not complete');
  return blockers;
}

export default function ModulePage() {
  const { id } = useParams<{ id: string }>();
  const { snapshot, apply, can, reasonFor, setNotice } = useTracker();
  const module = snapshot.modules.find((candidate) => candidate.id === id);

  const [linkType, setLinkType] = useState(snapshot.config.link_types[0] ?? 'RITM');
  const [linkLabel, setLinkLabel] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [newSubactivity, setNewSubactivity] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  if (!module) notFound();

  const { columns, stages, owners, link_types: linkTypes } = snapshot.config;
  const stage = stages[module.stage_index];
  const blockers = blockersFor(module);
  const canSignOff = can('fni.signoff');
  const canSetDate = can('fni.date');
  const canEdit = can('module.edit');
  const canUpdate = can('deliverable.update');
  const canConfirmProd = can('prod.confirm');

  const gateOpen = blockers.length === 0;
  const signOffDisabled = !canSignOff || (!module.closed && !gateOpen);
  const signOffReason = !canSignOff
    ? reasonFor('fni.signoff')
    : module.closed
      ? ''
      : blockers.length
        ? `Blocked — ${blockers.join('; ')}`
        : '';

  function advance(columnKey: string) {
    const cell = module!.cells.find((entry) => entry.column_key === columnKey);
    if (!cell) return;
    if (cell.rolled_up) {
      setNotice(
        'That value is rolled up from the subactivities and cannot be edited directly. Change it on the matrix, under this module.',
      );
      return;
    }
    if (!canUpdate) {
      setNotice(reasonFor('deliverable.update'));
      return;
    }
    void apply(
      (current) => optimisticAdvance(current, module!.id, null, columnKey, current.me.display_name),
      () =>
        send<Snapshot>('/api/v1/cells', 'PATCH', {
          module_id: module!.id,
          subactivity_id: null,
          column_key: columnKey,
        }),
    );
  }

  const handover = [
    { label: 'Dev complete, handed to testing', by: 'development team', ok: module.readiness >= 50 },
    { label: 'Testing signed off on lab / preprod', by: 'QA', ok: module.readiness >= 75 },
    {
      label: 'DevOps confirms every deliverable loaded in prod',
      by: 'DevOps',
      ok: module.readiness === 100,
    },
    {
      label: 'FNI final submission raised',
      by: 'FNI column on the matrix',
      ok: !blockers.includes('FNI final submission is not complete'),
    },
    {
      label: 'PM marks FNI done — closes the module and its subactivities',
      by: module.closed
        ? `${module.closed_by ?? 'PM'}, closed`
        : 'waiting on the PM',
      ok: module.closed,
    },
  ];

  return (
    <div className="page page-narrow">
      <div style={{ fontSize: 13, color: 'var(--color-neutral-600)', marginBottom: 'var(--space-2)' }}>
        <Link href="/matrix" style={{ color: 'inherit' }}>
          {snapshot.project.key}
        </Link>{' '}
        / {module.node_type}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-8)',
          marginBottom: 'var(--space-6)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1 style={{ wordBreak: 'break-word' }}>{module.name}</h1>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              marginTop: 'var(--space-2)',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span className="tag tag-accent">{module.node_type}</span>
            <span style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>
              {module.readiness}% of counted deliverables in prod
              {stage ? ` · ${stage.label}` : ''}
            </span>
            <span style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>
              target {module.fni_target_date ?? 'not set'}
            </span>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                fontSize: 13,
                color: 'var(--color-neutral-700)',
              }}
            >
              owner
              <select
                className="input"
                style={{ width: 150, padding: '2px 6px' }}
                value={module.owner ?? 'unassigned'}
                disabled={!canEdit}
                title={canEdit ? undefined : reasonFor('module.edit')}
                onChange={(event) => {
                  const value = event.target.value;
                  void apply(null, () =>
                    send<Snapshot>(`/api/v1/modules/${module.id}`, 'PATCH', {
                      owner: value === 'unassigned' ? null : value,
                    }),
                  );
                }}
              >
                {['unassigned', ...owners].map((owner) => (
                  <option key={owner} value={owner}>
                    {owner}
                  </option>
                ))}
              </select>
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)', flex: 'none' }}>
          <Link href="/drift" className="btn btn-secondary">
            Check drift
          </Link>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canConfirmProd || module.closed}
            title={canConfirmProd ? undefined : reasonFor('prod.confirm')}
            onClick={async () => {
              const meta = await apply(null, () =>
                send<Snapshot>(`/api/v1/modules/${module.id}/confirm-prod`, 'POST'),
              );
              if (meta) {
                setNotice(
                  `Marked ${meta.changed} cell${meta.changed === 1 ? '' : 's'} loaded in prod. Every change is stamped with your name.`,
                );
              }
            }}
          >
            Mark loaded in prod
          </button>
        </div>
      </div>

      <div
        className="split"
        style={{
          display: 'grid',
          gridTemplateColumns: '1.1fr 1fr',
          gap: 'var(--space-8)',
          alignItems: 'start',
        }}
      >
        <div>
          <SectionHeading first>Handover &amp; closure</SectionHeading>
          <Blueprint style={{ marginBottom: 'var(--space-8)' }}>
            {handover.map((step) => {
              const tone = step.ok ? TONE_STYLE.done : TONE_STYLE.none;
              return (
                <div
                  key={step.label}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-3) 0',
                    borderBottom: '1px solid var(--color-divider)',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 20,
                      height: 20,
                      flex: 'none',
                      marginTop: 2,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      background: tone.bg,
                      color: tone.fg,
                      border: `1px solid ${tone.border}`,
                    }}
                  >
                    {step.ok ? '●' : '○'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13 }}>{step.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{step.by}</div>
                  </div>
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 13,
                      letterSpacing: '.07em',
                      textTransform: 'uppercase',
                      color: 'var(--color-neutral-700)',
                      flex: 'none',
                    }}
                  >
                    {step.ok ? 'done' : 'pending'}
                  </span>
                </div>
              );
            })}

            <div
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                alignItems: 'center',
                flexWrap: 'wrap',
                paddingTop: 'var(--space-4)',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>FNI target date</span>
              <input
                className="input"
                type="date"
                style={{ width: 170 }}
                value={module.fni_target_date ?? ''}
                disabled={!canSetDate}
                title={canSetDate ? undefined : reasonFor('fni.date')}
                onChange={(event) => {
                  const value = event.target.value;
                  void apply(null, () =>
                    send<Snapshot>(`/api/v1/modules/${module.id}`, 'PATCH', {
                      fni_target_date: value || null,
                    }),
                  );
                }}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={signOffDisabled}
                title={signOffReason || undefined}
                onClick={() =>
                  void apply(null, () =>
                    send<Snapshot>(`/api/v1/modules/${module.id}/fni`, 'POST', {
                      close: !module.closed,
                    }),
                  )
                }
              >
                {module.closed ? 'Reopen activity' : 'Mark FNI done'}
              </button>
            </div>

            {signOffReason ? (
              <div
                style={{
                  marginTop: 'var(--space-3)',
                  fontSize: 12,
                  color: 'var(--color-neutral-700)',
                  textWrap: 'pretty',
                }}
              >
                {signOffReason}
              </div>
            ) : null}

            {module.closed ? (
              <div
                style={{
                  marginTop: 'var(--space-4)',
                  padding: 'var(--space-3) var(--space-4)',
                  background: 'var(--color-accent)',
                  color: 'var(--color-bg)',
                  fontFamily: 'var(--font-heading)',
                  fontSize: 15,
                  letterSpacing: '.05em',
                  textTransform: 'uppercase',
                }}
              >
                Closed — prod FNI signed off, our part is complete
              </div>
            ) : null}
          </Blueprint>

          <SectionHeading first>Deliverables</SectionHeading>
          <Blueprint padded={false}>
            {module.cells.map((cell) => {
              const column = columns.find((candidate) => candidate.key === cell.column_key);
              if (!column) return null;
              const view = cellPresentation(cell, column);
              return (
                <div
                  key={cell.column_key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-2) var(--space-4)',
                    borderBottom: '1px solid var(--color-divider)',
                  }}
                >
                  <StatusMarker cell={cell} column={column} size={22} onClick={() => advance(column.key)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13 }}>{column.full}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}>
                      {cell.rolled_up
                        ? `rolled up from ${cell.subactivity_count} subactivities`
                        : view.stamp}
                      {column.counts ? '' : ' · does not count toward prod'}
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--color-neutral-700)', flex: 'none' }}>
                    {view.status_label}
                  </span>
                </div>
              );
            })}
          </Blueprint>

          <SectionHeading>Subactivities</SectionHeading>
          <div className="bordered">
            {module.subactivities.map((subactivity) => {
              const editing = renaming?.id === subactivity.id;
              return (
                <div
                  key={subactivity.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-3) var(--space-4)',
                    borderBottom: '1px solid var(--color-divider)',
                  }}
                >
                  {editing ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const value = renaming.value.trim();
                        if (!value || value === subactivity.name) {
                          setRenaming(null);
                          return;
                        }
                        void apply(null, () =>
                          send<Snapshot>(
                            `/api/v1/modules/${module.id}/subactivities/${subactivity.id}`,
                            'PATCH',
                            { name: value },
                          ),
                        ).then(() => setRenaming(null));
                      }}
                      style={{ flex: 1, display: 'flex', gap: 'var(--space-2)' }}
                    >
                      <input
                        className="input"
                        autoFocus
                        style={{ flex: 1 }}
                        value={renaming.value}
                        onChange={(event) => setRenaming({ id: subactivity.id, value: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setRenaming(null);
                        }}
                        aria-label={`Rename ${subactivity.name}`}
                      />
                      <button type="submit" className="btn btn-secondary">
                        Save
                      </button>
                    </form>
                  ) : (
                    <span style={{ flex: 1, fontSize: 13 }}>{subactivity.name}</span>
                  )}

                  {editing ? null : (
                    <>
                      <span className="bar" style={{ width: 110, flex: 'none', height: 6 }} aria-hidden>
                        <span style={{ width: `${subactivity.readiness}%` }} />
                      </span>
                      <span
                        className="tabular"
                        style={{
                          width: 38,
                          flex: 'none',
                          textAlign: 'right',
                          fontFamily: 'var(--font-heading)',
                          fontSize: 15,
                        }}
                      >
                        {subactivity.readiness}
                      </span>
                      <div style={{ display: 'flex', gap: 'var(--space-2)', flex: 'none' }}>
                        <button
                          type="button"
                          disabled={!canEdit}
                          title={canEdit ? undefined : reasonFor('module.edit')}
                          onClick={() => setRenaming({ id: subactivity.id, value: subactivity.name })}
                          style={subactivityActionStyle(canEdit)}
                        >
                          rename
                        </button>
                        <button
                          type="button"
                          disabled={!canEdit}
                          title={
                            canEdit
                              ? module.subactivities.length === 1
                                ? 'Removing the last subactivity gives the module its own row back, keeping what it currently shows'
                                : `Remove ${subactivity.name} and its deliverable row`
                              : reasonFor('module.edit')
                          }
                          onClick={() =>
                            void apply(null, () =>
                              send<Snapshot>(
                                `/api/v1/modules/${module.id}/subactivities/${subactivity.id}`,
                                'DELETE',
                              ),
                            )
                          }
                          style={subactivityActionStyle(canEdit)}
                        >
                          remove
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            {module.subactivities.length === 0 ? (
              <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 13, color: 'var(--color-neutral-600)' }}>
                None.
              </div>
            ) : null}

            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!newSubactivity.trim()) return;
                void apply(null, () =>
                  send<Snapshot>(`/api/v1/modules/${module.id}/subactivities`, 'POST', {
                    name: newSubactivity.trim(),
                  }),
                ).then((result) => {
                  if (result) setNewSubactivity('');
                });
              }}
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                padding: 'var(--space-3) var(--space-4)',
                alignItems: 'center',
              }}
            >
              <input
                className="input"
                style={{ flex: 1 }}
                value={newSubactivity}
                onChange={(event) => setNewSubactivity(event.target.value)}
                placeholder="New subactivity, e.g. Deletion"
                aria-label="New subactivity name"
              />
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={!canEdit || module.closed}
                title={
                  canEdit
                    ? module.closed
                      ? 'This module is closed. Reopen it before changing its subactivities.'
                      : undefined
                    : reasonFor('module.edit')
                }
              >
                Add
              </button>
            </form>
          </div>
          <div
            style={{
              marginTop: 'var(--space-2)',
              fontSize: 12,
              color: 'var(--color-neutral-600)',
              lineHeight: 1.4,
              textWrap: 'pretty',
            }}
          >
            {module.subactivities.length
              ? 'The module row on the matrix is a roll-up: a column only counts as done when every subactivity is done. Edit the subactivity cells on the matrix.'
              : 'This module has no subactivities — its deliverable row is tracked directly. Adding the first one turns that row into a roll-up and carries the deliverables it already holds onto that subactivity.'}
          </div>

          <SectionHeading>Defects on this module</SectionHeading>
          <div className="bordered">
            {snapshot.defects
              .filter((defect) => defect.module_id === module.id)
              .map((defect) => (
                <div
                  key={defect.id}
                  style={{
                    padding: 'var(--space-3) var(--space-4)',
                    borderBottom: '1px solid var(--color-divider)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)' }}>
                    <span className="tag tag-neutral" style={{ flex: 'none' }}>
                      {defect.severity}
                    </span>
                    <span style={{ flex: 1, fontSize: 13, lineHeight: 1.35, textWrap: 'pretty' }}>
                      {defect.description}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-heading)',
                        fontSize: 12,
                        letterSpacing: '.08em',
                        textTransform: 'uppercase',
                        flex: 'none',
                      }}
                    >
                      {defect.status}
                    </span>
                  </div>
                  <div style={{ marginTop: 'var(--space-1)', fontSize: 12, color: 'var(--color-neutral-600)' }}>
                    {defect.phase} · run {defect.child_req_id || '—'} · {defect.raised_by},{' '}
                    {formatStamp(defect.created_at)}
                  </div>
                </div>
              ))}
            {snapshot.defects.filter((defect) => defect.module_id === module.id).length === 0 ? (
              <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 13, color: 'var(--color-neutral-600)' }}>
                None raised.
              </div>
            ) : null}
          </div>

          <SectionHeading>Links</SectionHeading>
          <Blueprint padded={false}>
            {module.links.map((link) => (
              <div
                key={link.id}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-3) var(--space-4)',
                  borderBottom: '1px solid var(--color-divider)',
                }}
              >
                <span className="tag tag-neutral" style={{ flex: 'none' }}>
                  {link.type}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <a href={link.url} style={{ fontSize: 13 }} target="_blank" rel="noreferrer noopener">
                    {link.label}
                  </a>
                  <div
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: 'var(--color-neutral-600)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {link.url}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!canEdit}
                  title={canEdit ? undefined : reasonFor('module.edit')}
                  onClick={() =>
                    void apply(null, () => send<Snapshot>(`/api/v1/links/${link.id}`, 'DELETE'))
                  }
                  style={{
                    fontSize: 12,
                    color: 'var(--color-neutral-600)',
                    border: 0,
                    background: 'transparent',
                    cursor: canEdit ? 'pointer' : 'not-allowed',
                    flex: 'none',
                  }}
                >
                  remove
                </button>
              </div>
            ))}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!linkUrl.trim()) return;
                void apply(null, () =>
                  send<Snapshot>(`/api/v1/modules/${module.id}/links`, 'POST', {
                    type: linkType,
                    label: linkLabel,
                    url: linkUrl,
                  }),
                ).then((result) => {
                  if (result) {
                    setLinkLabel('');
                    setLinkUrl('');
                  }
                });
              }}
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                padding: 'var(--space-3) var(--space-4)',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <select
                className="input"
                style={{ width: 130 }}
                value={linkType}
                onChange={(event) => setLinkType(event.target.value)}
                aria-label="Link type"
              >
                {linkTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <input
                className="input"
                style={{ width: 140 }}
                value={linkLabel}
                onChange={(event) => setLinkLabel(event.target.value)}
                placeholder="Label"
                aria-label="Link label"
              />
              <input
                className="input"
                style={{ flex: 1, minWidth: 160 }}
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                placeholder="https://…"
                aria-label="Link URL"
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!canEdit}
                title={canEdit ? undefined : reasonFor('module.edit')}
              >
                Add link
              </button>
            </form>
          </Blueprint>
        </div>

        <div>
          <SectionHeading first>Change history</SectionHeading>
          <div className="bordered">
            {snapshot.audit
              .filter((entry) => entry.module_id === module.id)
              .slice(0, 8)
              .map((entry) => (
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
                      width: 80,
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
            {snapshot.audit.filter((entry) => entry.module_id === module.id).length === 0 ? (
              <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 12, color: 'var(--color-neutral-600)' }}>
                No changes recorded against this module.
              </div>
            ) : null}
          </div>

          <SectionHeading>
            Last execution ·{' '}
            {module.last_run ? `CHILD_REQ_ID ${module.last_run.child_req_id}` : 'no execution recorded'}
          </SectionHeading>
          <div className="bordered">
            {module.last_run?.phases.map((phase) => (
              <div
                key={phase.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-2) var(--space-4)',
                  borderBottom: '1px solid var(--color-divider)',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    flex: 'none',
                    background: phase.ok ? 'var(--color-accent)' : 'var(--color-neutral-300)',
                  }}
                />
                <span className="mono" style={{ flex: 1, fontSize: 12 }}>
                  {phase.name}
                </span>
                <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>{phase.steps}</span>
                <span className="tabular" style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
                  {phase.duration}
                </span>
              </div>
            ))}
            {!module.last_run ? (
              <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 12, color: 'var(--color-neutral-600)' }}>
                No run has reported against this module.
              </div>
            ) : null}
          </div>

          <SectionHeading>Artifacts</SectionHeading>
          <div className="bordered">
            {module.last_run?.artifacts.map((artifact) => (
              <div
                key={artifact.path}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-2) var(--space-4)',
                  borderBottom: '1px solid var(--color-divider)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontSize: 12,
                    letterSpacing: '.1em',
                    textTransform: 'uppercase',
                    color: 'var(--color-neutral-600)',
                    width: 70,
                    flex: 'none',
                  }}
                >
                  {artifact.kind}
                </span>
                <span className="mono" style={{ flex: 1, fontSize: 12, wordBreak: 'break-all' }}>
                  {artifact.path}
                </span>
                <span
                  className="tabular"
                  style={{ fontSize: 12, color: 'var(--color-neutral-700)', flex: 'none' }}
                >
                  {artifact.size}
                </span>
              </div>
            ))}
            {!module.last_run ? (
              <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 12, color: 'var(--color-neutral-600)' }}>
                None.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
