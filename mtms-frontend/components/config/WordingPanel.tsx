'use client';

import { useEffect, useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint } from '@/components/primitives';
import { send } from '@/lib/client/api';
import type { Snapshot } from '@/lib/shared/views';
import { plural } from '@/lib/shared/wording';

/**
 * What this project calls its three levels.
 *
 * The other half of making the product generic. Columns and stages made the *process*
 * configurable; this makes the *vocabulary* configurable, so a team that says "node" and
 * "activity" is not reading somebody else's words on every screen.
 *
 * Only the labels move. Nothing renames a table, a permission key or a URL — those are
 * written into stored rows and into client code, and following a text box with a migration
 * every time somebody edited it would be a bad trade for a heading.
 */

const FIELDS = [
  {
    key: 'moduleLabel' as const,
    read: 'module_label' as const,
    title: 'The top level',
    product: 'Module',
    example: 'CR_AUTOMATION calls it a Node — SBC, MRF, CFX.',
  },
  {
    key: 'subModuleLabel' as const,
    read: 'sub_module_label' as const,
    title: 'One row on the matrix',
    product: 'Sub-module',
    example: 'CR_AUTOMATION calls it an Activity.',
  },
  {
    key: 'subActivityLabel' as const,
    read: 'sub_activity_label' as const,
    title: 'The pieces of one row',
    product: 'Sub-activity',
    example: 'Addition, Deletion, Modification.',
  },
];

export function WordingPanel() {
  const { snapshot, apply, can, reasonFor } = useTracker();
  const { project } = snapshot;
  const canConfig = can('project.config');

  // Local drafts so typing does not fire a request per keystroke. Re-seeded when the snapshot
  // changes, so another admin's edit lands here rather than being overwritten by a stale box.
  const [draft, setDraft] = useState({
    moduleLabel: project.module_label,
    subModuleLabel: project.sub_module_label,
    subActivityLabel: project.sub_activity_label,
  });

  useEffect(() => {
    setDraft({
      moduleLabel: project.module_label,
      subModuleLabel: project.sub_module_label,
      subActivityLabel: project.sub_activity_label,
    });
  }, [project.module_label, project.sub_module_label, project.sub_activity_label]);

  /**
   * Saves one box.
   *
   * Keyed by `read`, the snake_case name, not by `key`. The wire is snake_case — the service
   * runs Jackson with SNAKE_CASE — so `{ moduleLabel: ... }` does not bind to anything. Every
   * field then arrived null, and because every field on this request is legitimately optional
   * (the screen saves one box at a time) the service had nothing to reject: it answered **200
   * and changed nothing**. A silent success is the worst of the failure modes, which is why the
   * two names are kept apart on FIELDS rather than one being derived from the other in passing.
   */
  function save(wireKey: (typeof FIELDS)[number]['read'], value: string) {
    void apply(null, () =>
      send<Snapshot>('/api/v1/config/vocabulary', 'PATCH', { [wireKey]: value }),
    );
  }

  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <Blueprint>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          <h4 className="section-heading" style={{ margin: 0 }}>
            What this project calls things
          </h4>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
            shown on every screen — the API and the database keep their own names
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
            gap: 'var(--space-4)',
            marginTop: 'var(--space-4)',
          }}
        >
          {FIELDS.map((field) => (
            <div key={field.key}>
              <label
                htmlFor={`wording-${field.key}`}
                style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}
              >
                {field.title}
              </label>
              <input
                id={`wording-${field.key}`}
                className="input"
                style={{ width: '100%', marginTop: 'var(--space-1)' }}
                value={draft[field.key]}
                disabled={!canConfig}
                title={canConfig ? undefined : reasonFor('project.config')}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                }
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value === project[field.read]) return;
                  save(field.read, value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    setDraft((current) => ({ ...current, [field.key]: project[field.read] }));
                  }
                }}
              />
              <div style={{ fontSize: 11, color: 'var(--color-neutral-600)', marginTop: 2 }}>
                {/*
                  The plural is shown rather than asked for. One box per level, three boxes
                  total — asking for six would be how a project ends up saying "Node" in one
                  heading and nothing in the next because somebody filled in half of them.
                */}
                plural: {plural(draft[field.key].trim() || field.product)} · product&apos;s own word:{' '}
                {field.product}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-neutral-600)', textWrap: 'pretty' }}>
                {field.example}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: 'var(--space-4)',
            fontSize: 12,
            color: 'var(--color-neutral-700)',
            textWrap: 'pretty',
          }}
        >
          Leave one blank to put it back to the product&apos;s own word. Changing these renames
          nothing underneath — saved records, permissions and links are untouched, so it is safe
          to try a word and change your mind.
        </div>
      </Blueprint>
    </div>
  );
}
