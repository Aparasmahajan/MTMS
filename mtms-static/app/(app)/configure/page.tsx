'use client';

import { useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, PageTitle } from '@/components/primitives';
import { send } from '@/lib/client/api';
import type { ConfigList, Environment } from '@/lib/shared/domain';
import { PROD_ENVIRONMENT } from '@/lib/shared/domain';
import {
  isStatusKey,
  statusEntry,
  STATUS_VOCABULARY,
  TONE_DESCRIPTION,
  TONE_STYLE,
} from '@/lib/shared/vocabulary';
import { columnDisplayLabel } from '@/lib/shared/views';
import type { ColumnView, Snapshot } from '@/lib/shared/views';

/**
 * Configure — everything a project admin sets, and the reason the app is generic.
 *
 * The matrix is generated from this screen. Nothing below is hard-coded anywhere else:
 * add a column here and it appears on the matrix, in the readiness maths, on the module
 * detail and in the drift table, for every module in the project.
 */

function ConfigSet({
  title,
  hint,
  list,
  placeholder,
  values,
}: {
  title: string;
  hint: string;
  list: ConfigList;
  placeholder: string;
  values: { key: string; label: string }[];
}) {
  const { apply, can, reasonFor } = useTracker();
  const [draft, setDraft] = useState('');
  const canConfig = can('project.config');

  function change(action: 'add' | 'remove', value: string) {
    void apply(null, () =>
      send<Snapshot>('/api/v1/config/lists', 'POST', { list, action, value }),
    ).then((result) => {
      if (result && action === 'add') setDraft('');
    });
  }

  return (
    <Blueprint>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
        }}
      >
        <h4 className="section-heading" style={{ margin: 0 }}>
          {title}
        </h4>
        <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{hint}</span>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-2)',
          marginTop: 'var(--space-4)',
        }}
      >
        {values.map((value) => (
          <div
            key={value.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-1) var(--space-3)',
              border: '1px solid var(--color-neutral-400)',
              background: 'var(--color-accent-100)',
              fontSize: 13,
            }}
          >
            <span>{value.label}</span>
            <button
              type="button"
              className="mono"
              disabled={!canConfig}
              title={canConfig ? `Remove ${value.label}` : reasonFor('project.config')}
              onClick={() => change('remove', value.key)}
              style={{
                border: 0,
                background: 'transparent',
                padding: 0,
                cursor: canConfig ? 'pointer' : 'not-allowed',
                color: 'var(--color-neutral-600)',
              }}
            >
              ×
            </button>
          </div>
        ))}
        {values.length === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--color-neutral-600)' }}>None yet.</span>
        ) : null}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) change('add', draft.trim());
        }}
        style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}
      >
        <input
          className="input"
          style={{ flex: 1 }}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          aria-label={`Add to ${title}`}
        />
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={!canConfig}
          title={canConfig ? undefined : reasonFor('project.config')}
        >
          Add
        </button>
      </form>
    </Blueprint>
  );
}

/**
 * The statuses a column may take, as a toggle per entry in the shared vocabulary.
 *
 * Turning one off never rewrites cells that already hold it — see `setColumnStatuses`.
 * Those cells keep their recorded status and are counted back here, so the consequence
 * of the change is visible on the screen that made it.
 */
function StatusSubset({ column }: { column: ColumnView }) {
  const { apply, can, reasonFor, setNotice } = useTracker();
  const canConfig = can('project.config');
  const selectable = Object.keys(STATUS_VOCABULARY).filter(isStatusKey);

  function toggle(key: string) {
    if (!canConfig) {
      setNotice(reasonFor('project.config'));
      return;
    }
    const next = column.allowed.includes(key)
      ? column.allowed.filter((entry) => entry !== key)
      : [...column.allowed, key];

    if (next.length === 0) {
      setNotice(`${columnDisplayLabel(column)} needs at least one status it can take.`);
      return;
    }
    void apply(null, () =>
      send<Snapshot>(`/api/v1/config/columns/${column.key}`, 'PATCH', { allowed: next }),
    );
  }

  return (
    <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
      {selectable.map((key) => {
        const on = column.allowed.includes(key);
        const entry = statusEntry(key);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            disabled={!canConfig}
            title={
              canConfig
                ? `${on ? 'Remove' : 'Add'} ${entry.label} ${on ? 'from' : 'to'} ${columnDisplayLabel(column)}`
                : reasonFor('project.config')
            }
            onClick={() => toggle(key)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              padding: '1px 7px',
              borderRadius: 0,
              border: `1px solid ${on ? 'var(--color-text)' : 'var(--color-neutral-300)'}`,
              background: on ? 'var(--color-accent-100)' : 'transparent',
              color: on ? 'var(--color-text)' : 'var(--color-neutral-600)',
              cursor: canConfig ? 'pointer' : 'not-allowed',
              opacity: canConfig ? 1 : 0.6,
            }}
          >
            <span aria-hidden className="mono">
              {entry.mark}
            </span>
            {entry.label}
          </button>
        );
      })}
      {column.off_vocabulary > 0 ? (
        <div
          style={{
            width: '100%',
            marginTop: 'var(--space-1)',
            fontSize: 11,
            color: 'var(--color-neutral-700)',
            textWrap: 'pretty',
          }}
        >
          {column.off_vocabulary} {column.off_vocabulary === 1 ? 'cell holds' : 'cells hold'} a status
          this column no longer allows. They keep what was recorded — clicking one moves it into the
          list above.
        </div>
      ) : null}
    </div>
  );
}

/**
 * Environments, and the switch that takes one off the grid.
 *
 * Off is not a delete and the copy has to say so, because the operator reaching for it is
 * usually mid-incident — preprod is down, the window is open, and they want the column to
 * stop dragging every percentage below 100. Every cell survives; switching back on
 * restores exactly what was recorded.
 */
function Environments({
  environments,
  columns,
}: {
  environments: Environment[];
  columns: ColumnView[];
}) {
  const { apply, can, reasonFor, setNotice } = useTracker();
  const canConfig = can('project.config');

  if (environments.length === 0) return null;

  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <Blueprint>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <h4 className="section-heading" style={{ margin: 0 }}>
            Environments
          </h4>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
            switching one off hides its columns — it never deletes a cell
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          {environments.map((environment) => {
            const mine = columns.filter((column) => column.environment === environment.key);
            const isProd = environment.key === PROD_ENVIRONMENT;
            const locked = !canConfig || isProd;

            return (
              <div
                key={environment.key}
                style={{
                  border: '1px solid var(--color-divider)',
                  padding: 'var(--space-3)',
                  background: environment.enabled ? 'transparent' : 'var(--color-neutral-100)',
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
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 15,
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                    }}
                  >
                    {environment.short}
                  </span>
                  <button
                    type="button"
                    aria-pressed={environment.enabled}
                    disabled={locked}
                    title={
                      isProd
                        ? 'Prod cannot be switched off — readiness is measured against it.'
                        : canConfig
                          ? `Switch ${environment.label} ${environment.enabled ? 'off' : 'on'}`
                          : reasonFor('project.config')
                    }
                    onClick={() => {
                      if (isProd) {
                        setNotice(
                          'Prod cannot be switched off — readiness is measured against it, and the FNI gate reads that percentage.',
                        );
                        return;
                      }
                      void apply(null, () =>
                        send<Snapshot>(`/api/v1/config/environments/${environment.key}`, 'PATCH', {
                          enabled: !environment.enabled,
                        }),
                      );
                    }}
                    style={{
                      fontSize: 13,
                      borderRadius: 0,
                      border: '1px solid var(--color-neutral-400)',
                      background: environment.enabled ? 'var(--color-accent-100)' : 'transparent',
                      color: 'var(--color-neutral-700)',
                      padding: '1px 8px',
                      cursor: locked ? 'not-allowed' : 'pointer',
                      opacity: locked && !isProd ? 0.6 : 1,
                    }}
                  >
                    {environment.enabled ? 'on' : 'off'}
                  </button>
                </div>
                <div style={{ fontSize: 13, marginTop: 'var(--space-1)' }}>{environment.label}</div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--color-neutral-600)',
                    marginTop: 'var(--space-1)',
                    textWrap: 'pretty',
                  }}
                >
                  {mine.length} {mine.length === 1 ? 'column' : 'columns'}
                  {isProd
                    ? ' · readiness is measured here, so this one stays on'
                    : environment.enabled
                      ? ' · on the matrix, not counted toward readiness'
                      : ' · hidden, cells kept'}
                </div>
              </div>
            );
          })}
        </div>
      </Blueprint>
    </div>
  );
}

export default function ConfigurePage() {
  const { snapshot, apply, can, reasonFor } = useTracker();
  const { config, project } = snapshot;
  const [newColumn, setNewColumn] = useState('');
  const canConfig = can('project.config');

  return (
    <div className="page page-narrow">
      <PageTitle
        title={`Configure — ${project.key}`}
        lede="What a project admin sets. Another team stands up its own process here without a code change."
      />

      <Blueprint style={{ marginBottom: 'var(--space-8)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <h4 className="section-heading" style={{ margin: 0 }}>
            Deliverable columns
          </h4>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
            each column uses its own subset of the shared status vocabulary
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Column</th>
                <th>What it is</th>
                <th>Statuses it can take</th>
                <th>Counts toward prod</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {config.columns.map((column, index) => (
                <tr key={column.key}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 2 }}>
                      {(['up', 'down'] as const).map((direction) => {
                        const stuck =
                          direction === 'up' ? index === 0 : index === config.columns.length - 1;
                        return (
                          <button
                            key={direction}
                            type="button"
                            className="mono"
                            disabled={!canConfig || stuck}
                            title={
                              canConfig
                                ? `Move ${columnDisplayLabel(column)} ${direction === 'up' ? 'earlier' : 'later'} on the matrix`
                                : reasonFor('project.config')
                            }
                            aria-label={`Move ${columnDisplayLabel(column)} ${direction === 'up' ? 'earlier' : 'later'}`}
                            onClick={() =>
                              void apply(null, () =>
                                send<Snapshot>(`/api/v1/config/columns/${column.key}`, 'PATCH', {
                                  move: direction,
                                }),
                              )
                            }
                            style={{
                              width: 20,
                              height: 20,
                              padding: 0,
                              fontSize: 11,
                              lineHeight: 1,
                              borderRadius: 0,
                              border: '1px solid var(--color-neutral-400)',
                              background: 'transparent',
                              color: 'var(--color-neutral-700)',
                              cursor: canConfig && !stuck ? 'pointer' : 'not-allowed',
                              opacity: canConfig && !stuck ? 1 : 0.35,
                            }}
                          >
                            {direction === 'up' ? '←' : '→'}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                  <td
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 15,
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      whiteSpace: 'nowrap',
                      // A hidden column is still listed — it is how you find it to bring
                      // it back, and its cells are still there behind it.
                      opacity: column.active ? 1 : 0.5,
                    }}
                  >
                    {columnDisplayLabel(column)}
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {column.full}
                    {column.active ? null : (
                      <span style={{ color: 'var(--color-neutral-600)' }}>
                        {' '}
                        — hidden, its environment is switched off
                      </span>
                    )}
                  </td>
                  <td style={{ minWidth: 260 }}>
                    <StatusSubset column={column} />
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={!canConfig}
                      title={
                        canConfig
                          ? 'Toggle whether this column enters the readiness percentage'
                          : reasonFor('project.config')
                      }
                      onClick={() =>
                        void apply(null, () =>
                          send<Snapshot>(`/api/v1/config/columns/${column.key}`, 'PATCH', {
                            counts: !column.counts,
                          }),
                        )
                      }
                      style={{
                        fontSize: 13,
                        color: 'var(--color-neutral-700)',
                        border: '1px solid var(--color-neutral-400)',
                        borderRadius: 0,
                        background: column.counts ? 'var(--color-accent-100)' : 'transparent',
                        padding: '1px 8px',
                        cursor: canConfig ? 'pointer' : 'not-allowed',
                      }}
                    >
                      {column.counts ? 'counts' : 'informational'}
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={!canConfig}
                      title={canConfig ? undefined : reasonFor('project.config')}
                      onClick={() =>
                        void apply(null, () =>
                          send<Snapshot>(`/api/v1/config/columns/${column.key}`, 'DELETE'),
                        )
                      }
                      style={{
                        fontSize: 12,
                        color: 'var(--color-neutral-600)',
                        border: 0,
                        background: 'transparent',
                        cursor: canConfig ? 'pointer' : 'not-allowed',
                      }}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!newColumn.trim()) return;
            void apply(null, () =>
              send<Snapshot>('/api/v1/config/columns', 'POST', { name: newColumn.trim() }),
            ).then((result) => {
              if (result) setNewColumn('');
            });
          }}
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            marginTop: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <input
            className="input"
            style={{ width: 240 }}
            value={newColumn}
            onChange={(event) => setNewColumn(event.target.value)}
            placeholder="New column, e.g. SMOKE TEST"
            aria-label="New column name"
          />
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={!canConfig}
            title={canConfig ? undefined : reasonFor('project.config')}
          >
            Add column
          </button>
          <span
            style={{
              fontSize: 12,
              color: 'var(--color-neutral-600)',
              alignSelf: 'center',
              textWrap: 'pretty',
            }}
          >
            A new column starts blank on every module, taking Not Loaded / Loaded and counting toward
            prod. Change any of that here — cells already filled in keep what they hold.
          </span>
        </form>
      </Blueprint>

      <div
        className="split"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-8)',
          alignItems: 'start',
        }}
      >
        <ConfigSet
          title="Node types"
          hint="more will come"
          list="node_types"
          placeholder="e.g. HSS"
          values={config.node_types.map((name) => ({ key: name, label: name }))}
        />
        <ConfigSet
          title="Pipeline stages"
          hint="board columns"
          list="stages"
          placeholder="New stage name"
          values={config.stages.map((stage) => ({ key: stage.id, label: stage.label }))}
        />
        <ConfigSet
          title="Owners"
          hint="who can be assigned"
          list="owners"
          placeholder="Name"
          values={config.owners.map((owner) => ({ key: owner, label: owner }))}
        />
        <ConfigSet
          title="Link types"
          hint="attachable to a module"
          list="link_types"
          placeholder="e.g. Test report"
          values={config.link_types.map((type) => ({ key: type, label: type }))}
        />

        <Environments environments={config.environments} columns={config.columns} />

        <div style={{ gridColumn: '1 / -1' }}>
          <Blueprint>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-4)',
                flexWrap: 'wrap',
              }}
            >
              <h4 className="section-heading" style={{ margin: 0 }}>
                Status vocabulary
              </h4>
              <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
                shared across the project — columns pick from it
              </span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
                gap: 'var(--space-3)',
              }}
            >
              {Object.entries(STATUS_VOCABULARY).map(([key, entry]) => {
                const tone = TONE_STYLE[entry.tone];
                return (
                  <div
                    key={key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                      border: '1px solid var(--color-divider)',
                      padding: 'var(--space-2) var(--space-3)',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 22,
                        height: 22,
                        flex: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        background: tone.bg,
                        color: tone.fg,
                        border: `1px solid ${tone.border}`,
                      }}
                    >
                      {entry.mark}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{entry.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}>
                        {TONE_DESCRIPTION[entry.tone]}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Blueprint>
        </div>

        <div
          style={{
            gridColumn: '1 / -1',
            border: '1px dashed var(--color-neutral-400)',
            padding: 'var(--space-6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-6)',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h4 className="section-heading" style={{ margin: '0 0 var(--space-1)' }}>
              Super admin
            </h4>
            <div
              style={{
                fontSize: 13,
                color: 'var(--color-neutral-700)',
                maxWidth: '70ch',
                textWrap: 'pretty',
              }}
            >
              Creating organisations, onboarding project admins and assigning them to projects sits
              one level above this screen. Out of scope for the {project.key} release — the model is
              built, the screen is not.
            </div>
          </div>
          <span
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 14,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              color: 'var(--color-neutral-600)',
              flex: 'none',
            }}
          >
            Later
          </span>
        </div>
      </div>
    </div>
  );
}
