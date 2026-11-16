'use client';

import { useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, EmptyRow } from '@/components/primitives';
import { send } from '@/lib/client/api';
import type { Snapshot } from '@/lib/shared/views';

/**
 * The roles this organisation has — adding one, renaming it, and hiding one it does not use.
 *
 * The six that ship fit the team this was built for and nobody else exactly. A hardware team
 * wants "Field Engineer" and a billing team wants "Revenue Assurance", and neither should have
 * to ask us for a release.
 *
 * **Hide, never delete**, and the distinction is the whole point. A role that was ever used is
 * referenced by the memberships that recorded who had access, by the steps it gates, and by the
 * owner rows that name it as a team. Deleting it would take those with it and rewrite history to
 * say the access never existed. So hiding removes it from every picker — owner teams, "who may
 * tick this step", the member role selector — and leaves every row pointing at it exactly where
 * it is.
 *
 * The grid below this panel is where permissions are granted. A role added here arrives with
 * none, on purpose: the alternative is somebody granting more than they meant to by clicking
 * "add".
 */
/**
 * A count that says more on hover — the permissions or the people themselves, not just
 * how many. Pure CSS positioning plus one bit of state per trigger; no portal, because
 * nothing here needs to escape the row it is drawn in.
 */
function HoverList({
  label,
  items,
  empty,
  mono,
}: {
  label: string;
  items: string[];
  empty: string;
  /** Permission keys read as code (`project.config`); names do not. */
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span style={{ textDecoration: 'underline dotted', textUnderlineOffset: 3, cursor: 'default' }}>
        {label}
      </span>
      {open ? (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            zIndex: 10,
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 180,
            maxWidth: 260,
            background: 'var(--color-bg)',
            border: '1px solid var(--color-neutral-400)',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
            padding: 'var(--space-2) var(--space-3)',
            textAlign: 'left',
          }}
        >
          {items.length === 0 ? (
            <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{empty}</span>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {items.map((item) => (
                <li
                  key={item}
                  className={mono ? 'mono' : undefined}
                  style={{ fontSize: 12, color: 'var(--color-text)' }}
                >
                  {item}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  );
}

export function RolesPanel() {
  const { snapshot, apply, can, reasonFor, setNotice } = useTracker();
  const canManage = can('admin.roles.manage');

  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const live = snapshot.roles.filter((role) => !role.hidden);
  const hidden = snapshot.roles.filter((role) => role.hidden);

  function setHidden(roleId: string, next: boolean) {
    void apply(null, () =>
      send<Snapshot>(`/api/v1/roles/${roleId}/visibility`, 'PATCH', { hidden: next }),
    );
  }

  return (
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
          Roles in this organisation
        </h4>
        <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
          also the teams an owner can be assigned for
        </span>
      </div>

      <div className="bordered">
        {live.map((role) =>
          editing === role.id ? (
            <RoleEditor
              key={role.id}
              role={role}
              onDone={() => setEditing(null)}
            />
          ) : (
            <div
              key={role.id}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 'var(--space-3)',
                padding: 'var(--space-3) var(--space-4)',
                borderBottom: '1px solid var(--color-divider)',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 13, minWidth: 120 }}>{role.name}</span>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--color-neutral-600)', minWidth: 0 }}>
                {role.note}
              </span>
              <span style={{ fontSize: 11, color: 'var(--color-neutral-600)', flex: 'none' }}>
                <HoverList
                  label={`${role.permissions.length} ${role.permissions.length === 1 ? 'permission' : 'permissions'}`}
                  items={role.permissions}
                  empty="No permissions granted yet."
                  mono
                />{' '}
                ·{' '}
                <HoverList
                  label={`${role.member_count} ${role.member_count === 1 ? 'person' : 'people'}`}
                  items={role.member_names}
                  empty="Nobody holds this role yet."
                />
                {role.is_system ? ' · shipped' : ''}
              </span>
              <div style={{ display: 'flex', gap: 'var(--space-3)', flex: 'none' }}>
                <button
                  type="button"
                  disabled={!canManage}
                  title={canManage ? undefined : reasonFor('admin.roles.manage')}
                  onClick={() => setEditing(role.id)}
                  style={quiet(canManage)}
                >
                  rename
                </button>
                <button
                  type="button"
                  disabled={!canManage}
                  title={
                    !canManage
                      ? reasonFor('admin.roles.manage')
                      : role.key === 'admin'
                        ? 'The admin role cannot be hidden — it is the one an administrator is assigned.'
                        : role.member_count > 0
                          ? `${role.member_count} still hold this. Move them first.`
                          : `Hide ${role.name}. Everything recorded against it is kept.`
                  }
                  onClick={() => {
                    // The server refuses both of these and says why. Saying it here too means
                    // the click does not have to fail to teach somebody the rule.
                    if (role.key === 'admin') {
                      setNotice(
                        'The admin role cannot be hidden — it is the one the platform console assigns, and without it this organisation could not be administered at all.',
                      );
                      return;
                    }
                    if (role.member_count > 0) {
                      setNotice(
                        `${role.member_count} ${role.member_count === 1 ? 'person still holds' : 'people still hold'} ${role.name}. Move them to another role first — hiding it now would leave access granted through a role no screen shows.`,
                      );
                      return;
                    }
                    setHidden(role.id, true);
                  }}
                  style={quiet(canManage)}
                >
                  hide
                </button>
              </div>
            </div>
          ),
        )}

        {live.length === 0 ? <EmptyRow>Every role is hidden.</EmptyRow> : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            void apply(null, () =>
              send<Snapshot>('/api/v1/roles', 'POST', { name: name.trim(), note: note.trim() }),
            ).then((result) => {
              if (result) {
                setName('');
                setNote('');
              }
            });
          }}
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            padding: 'var(--space-3) var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <input
            className="input"
            style={{ width: 170 }}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="New role, e.g. Field Engineer"
            aria-label="New role name"
          />
          <input
            className="input"
            style={{ flex: 1, minWidth: 160 }}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What they do (optional)"
            aria-label="New role note"
          />
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={!canManage}
            title={canManage ? undefined : reasonFor('admin.roles.manage')}
          >
            Add role
          </button>
        </form>
      </div>

      {hidden.length ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div className="kicker" style={{ fontSize: 11, letterSpacing: '.09em' }}>
            Hidden
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
              marginTop: 'var(--space-2)',
            }}
          >
            {hidden.map((role) => (
              <button
                key={role.id}
                type="button"
                className="chip"
                disabled={!canManage}
                title={`Show ${role.name} again. Everything recorded against it while it was hidden is still there.`}
                onClick={() => setHidden(role.id, false)}
              >
                {role.name} — show again
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div
        style={{
          marginTop: 'var(--space-4)',
          fontSize: 12,
          color: 'var(--color-neutral-700)',
          textWrap: 'pretty',
        }}
      >
        A new role arrives with no permissions — grant them in the grid below. Hiding one removes
        it from the owner teams, from the &ldquo;who may tick this step&rdquo; picker and from the
        member role selector, and keeps every tick, membership and owner row that already names
        it.
      </div>
    </Blueprint>
  );
}

function RoleEditor({
  role,
  onDone,
}: {
  role: Snapshot['roles'][number];
  onDone: () => void;
}) {
  const { apply } = useTracker();
  const [name, setName] = useState(role.name);
  const [note, setNote] = useState(role.note);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void apply(null, () =>
          send<Snapshot>(`/api/v1/roles/${role.id}`, 'PATCH', {
            name: name.trim(),
            note: note.trim(),
          }),
        ).then((result) => {
          if (result) onDone();
        });
      }}
      style={{
        display: 'flex',
        gap: 'var(--space-2)',
        padding: 'var(--space-3) var(--space-4)',
        borderBottom: '1px solid var(--color-divider)',
        background: 'var(--color-accent-100)',
        flexWrap: 'wrap',
      }}
    >
      <input
        className="input"
        autoFocus
        style={{ width: 170 }}
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label={`Rename ${role.name}`}
      />
      <input
        className="input"
        style={{ flex: 1, minWidth: 160 }}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        aria-label={`Note for ${role.name}`}
      />
      <button type="submit" className="btn btn-primary">
        Save
      </button>
      <button type="button" className="btn btn-secondary" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

function quiet(enabled: boolean) {
  return {
    fontSize: 12,
    color: 'var(--color-neutral-600)',
    border: 0,
    background: 'transparent',
    padding: 0,
    cursor: enabled ? 'pointer' : 'not-allowed',
  } as const;
}
