'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, PageTitle } from '@/components/primitives';
import { send } from '@/lib/client/api';
import type { Snapshot } from '@/lib/shared/views';

/**
 * The module library — a module is a node type plus an activity, built once. Cloning
 * copies the definition and starts fresh tracking; the library entry is unaffected, so
 * the same module can exist in several projects at once with its own status data.
 *
 * Creating one directly lives here too: this is where modules come from, and the
 * "add to the library" checkbox only makes sense next to the catalogue it adds to.
 */
export default function LibraryPage() {
  const { snapshot, apply, can, reasonFor, setNotice } = useTracker();
  const router = useRouter();
  const canClone = can('module.clone');
  const canCreate = can('module.create');

  const nodeTypes = snapshot.config.node_types;
  const [nodeType, setNodeType] = useState(nodeTypes[0] ?? '');
  const [name, setName] = useState('');
  const [addToLibrary, setAddToLibrary] = useState(false);

  async function clone(entryId: string) {
    const meta = await apply(null, () => send<Snapshot>(`/api/v1/library/${entryId}/clone`, 'POST'));
    if (meta?.node_type) {
      router.push(`/matrix?node=${encodeURIComponent(String(meta.node_type))}`);
    }
  }

  async function create() {
    if (!name.trim()) return;
    if (!nodeType) {
      setNotice('This project has no node types yet. Add one on the Configure screen first.');
      return;
    }
    const meta = await apply(null, () =>
      send<Snapshot>('/api/v1/modules', 'POST', {
        node_type: nodeType,
        name: name.trim(),
        add_to_library: addToLibrary,
      }),
    );
    if (meta) {
      setName('');
      router.push(`/matrix?node=${encodeURIComponent(nodeType)}`);
    }
  }

  return (
    <div className="page page-narrow">
      <PageTitle
        title="Module library"
        lede="A module is a node type plus an activity, built once. Clone it into a project and its own tracking starts from scratch — the library entry is not affected."
      />

      <Blueprint style={{ marginBottom: 'var(--space-6)' }}>
        <div className="kicker" style={{ letterSpacing: '.13em', marginBottom: 'var(--space-3)' }}>
          Not in the library — create it directly
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
          style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}
        >
          <select
            className="input"
            style={{ width: 130 }}
            value={nodeType}
            onChange={(event) => setNodeType(event.target.value)}
            aria-label="Node type"
          >
            {nodeTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
            {nodeTypes.length === 0 ? <option value="">No node types</option> : null}
          </select>
          <input
            className="input"
            style={{ flex: 1, minWidth: 280 }}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Activity, e.g. 131_CODEC_PROFILE_MODIFICATION_IN_CFX"
            aria-label="Activity name"
          />
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              fontSize: 13,
              whiteSpace: 'nowrap',
            }}
          >
            <input
              type="checkbox"
              checked={addToLibrary}
              onChange={(event) => setAddToLibrary(event.target.checked)}
            />
            Add to the library
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canCreate}
            title={canCreate ? undefined : reasonFor('module.create')}
          >
            Create module
          </button>
        </form>
        <div style={{ marginTop: 'var(--space-3)', fontSize: 12, color: 'var(--color-neutral-700)', textWrap: 'pretty' }}>
          {canCreate
            ? 'Every cell starts blank. The node type and the activity name together are the module’s identity, so the same pair cannot be tracked twice in one project. Tick the box only if other projects should be able to clone it.'
            : reasonFor('module.create')}
        </div>
      </Blueprint>

      <div className="bordered" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Node type</th>
              <th>Activity</th>
              <th>Version</th>
              <th>Subactivities</th>
              <th>Used in</th>
              <th>Here</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {snapshot.library.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <span className="tag tag-accent">{entry.node_type}</span>
                </td>
                <td style={{ fontSize: 12, wordBreak: 'break-word', maxWidth: 380 }}>{entry.name}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {entry.version}
                </td>
                <td style={{ fontSize: 12, color: 'var(--color-neutral-700)', whiteSpace: 'nowrap' }}>
                  {entry.subactivity_count
                    ? `${entry.subactivity_count} subactivities`
                    : 'no subactivities'}
                </td>
                <td style={{ fontSize: 12, color: 'var(--color-neutral-700)', whiteSpace: 'nowrap' }}>
                  {entry.used_in_projects} {entry.used_in_projects === 1 ? 'project' : 'projects'}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 12,
                      letterSpacing: '.08em',
                      textTransform: 'uppercase',
                      padding: '2px 8px',
                      border: '1px solid var(--color-neutral-400)',
                      background: entry.in_this_project ? 'var(--color-accent-200)' : 'transparent',
                      color: entry.in_this_project
                        ? 'var(--color-accent-800)'
                        : 'var(--color-neutral-700)',
                    }}
                  >
                    {entry.in_this_project ? 'In this project' : 'Not in this project'}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!canClone}
                    title={canClone ? undefined : reasonFor('module.clone')}
                    onClick={() => void clone(entry.id)}
                  >
                    {entry.in_this_project ? 'Clone again' : 'Clone into project'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 'var(--space-3)', fontSize: 12, color: 'var(--color-neutral-600)' }}>
        A clone starts with an empty deliverable row, so every gap shows as a blank rather than as a
        status nobody set. If the node type is new to this project it is added to the project&apos;s
        node types.
      </div>
    </div>
  );
}
