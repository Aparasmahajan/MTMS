'use client';

import { useRouter } from 'next/navigation';
import { useTracker } from '@/components/TrackerProvider';
import { PageTitle } from '@/components/primitives';
import { send } from '@/lib/client/api';
import type { Snapshot } from '@/lib/shared/views';

/**
 * The module library — a module is a node type plus an activity, built once. Cloning
 * copies the definition and starts fresh tracking; the library entry is unaffected, so
 * the same module can exist in several projects at once with its own status data.
 */
export default function LibraryPage() {
  const { snapshot, apply, can, reasonFor } = useTracker();
  const router = useRouter();
  const canClone = can('module.clone');

  async function clone(entryId: string) {
    const meta = await apply(null, () => send<Snapshot>(`/api/v1/library/${entryId}/clone`, 'POST'));
    if (meta?.node_type) {
      router.push(`/matrix?node=${encodeURIComponent(String(meta.node_type))}`);
    }
  }

  return (
    <div className="page page-narrow">
      <PageTitle
        title="Module library"
        lede="A module is a node type plus an activity, built once. Clone it into a project and its own tracking starts from scratch — the library entry is not affected."
      />

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
