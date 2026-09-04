'use client';

import { useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, PageTitle } from '@/components/primitives';
import { send } from '@/lib/client/api';
import type { ConfigList } from '@/lib/shared/domain';
import { statusEntry, STATUS_VOCABULARY, TONE_DESCRIPTION, TONE_STYLE } from '@/lib/shared/vocabulary';
import type { Snapshot } from '@/lib/shared/views';

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
                <th>Column</th>
                <th>What it is</th>
                <th>Statuses it can take</th>
                <th>Counts toward prod</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {config.columns.map((column) => (
                <tr key={column.key}>
                  <td
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 15,
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {column.label}
                  </td>
                  <td style={{ fontSize: 13 }}>{column.full}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                      {column.allowed.map((key) => (
                        <span key={key} className="tag tag-outline">
                          {statusEntry(key).label}
                        </span>
                      ))}
                    </div>
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
            prod.
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
