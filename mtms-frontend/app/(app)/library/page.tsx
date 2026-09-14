'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, PageTitle } from '@/components/primitives';
import { send } from '@/lib/client/api';
import type { Snapshot } from '@/lib/shared/views';

/**
 * The sub-module library — a sub-module is a module plus an activity, built once. Cloning
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

  const moduleNames = snapshot.config.module_names;
  const [moduleName, setModuleName] = useState(moduleNames[0] ?? '');
  const [name, setName] = useState('');
  const [addToLibrary, setAddToLibrary] = useState(false);

  async function clone(entryId: string) {
    const meta = await apply(null, () => send<Snapshot>(`/api/v1/library/${entryId}/clone`, 'POST'));
    if (meta?.module_name) {
      router.push(`/matrix?node=${encodeURIComponent(String(meta.module_name))}`);
    }
  }

  async function create() {
    if (!name.trim()) return;
    if (!moduleName) {
      setNotice('This project has no modules yet. Add one on the Configure screen first.');
      return;
    }
    const meta = await apply(null, () =>
      send<Snapshot>('/api/v1/sub-modules', 'POST', {
        module_name: moduleName,
        name: name.trim(),
        add_to_library: addToLibrary,
      }),
    );
    if (meta) {
      setName('');
      router.push(`/matrix?node=${encodeURIComponent(moduleName)}`);
    }
  }

  return (
    <div className="page page-narrow">
      <PageTitle
        title="Sub-module library"
        lede="A sub-module is a module plus an activity, built once. Clone it into a project and its own tracking starts from scratch — the library entry is not affected."
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
            value={moduleName}
            onChange={(event) => setModuleName(event.target.value)}
            aria-label="Module"
          >
            {moduleNames.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
            {moduleNames.length === 0 ? <option value="">No modules</option> : null}
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
            ? 'Every cell starts blank. The module and the activity name together are the sub-module’s identity, so the same pair cannot be tracked twice in one project. Tick the box only if other projects should be able to clone it.'
            : reasonFor('module.create')}
        </div>
      </Blueprint>

      <div className="bordered" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Module</th>
              <th>Activity</th>
              <th>Version</th>
              <th>SubActivities</th>
              <th>Used in</th>
              <th>Here</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {snapshot.library.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <span className="tag tag-accent">{entry.module_name}</span>
                </td>
                <td style={{ fontSize: 12, wordBreak: 'break-word', maxWidth: 380 }}>{entry.name}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {entry.version}
                </td>
                <td style={{ fontSize: 12, color: 'var(--color-neutral-700)', whiteSpace: 'nowrap' }}>
                  {entry.sub_activity_count
                    ? `${entry.sub_activity_count} sub-activities`
                    : 'no sub-activities'}
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
        status nobody set. If the module is new to this project it is added to the project&apos;s
        modules.
      </div>
    </div>
  );
}
