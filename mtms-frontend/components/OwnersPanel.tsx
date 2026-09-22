'use client';

import { useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, EmptyRow, SectionHeading } from '@/components/primitives';
import { send } from '@/lib/client/api';
import type { OwnerGroupView, Snapshot } from '@/lib/shared/views';

/**
 * Who owns this thing: one overall owner, plus one per team.
 *
 * The teams **are** the project's roles. There is deliberately no second list of teams to keep
 * in step — an admin who hides the QA role has removed the QA row from every owner list in the
 * same action, which is what "a project with no SME team simply does not show an SME row" has to
 * mean if it is not to become a second thing to maintain.
 *
 * Rows appear because somebody is in them. An empty team is not drawn; the picker below offers
 * every live role, so adding the first person is what creates the row.
 */

const scopeLabel: Record<string, string> = {
  module: 'module',
  sub_module: 'sub-module',
  sub_activity: 'sub-activity',
};

export function OwnersPanel({
  scopeType,
  scopeId,
  groups,
  heading = 'Owners',
}: {
  scopeType: 'module' | 'sub_module' | 'sub_activity';
  scopeId: string;
  groups: OwnerGroupView[];
  heading?: string;
}) {
  const { snapshot, apply, can, reasonFor } = useTracker();
  const canEdit = can('module.edit');

  const [roleId, setRoleId] = useState('');
  const [userId, setUserId] = useState('');

  // Hidden roles are not teams anything can be owned for — the server refuses it, and offering
  // them here would be a control that looks available and then does not work.
  const teams = snapshot.roles.filter((role) => !role.hidden);
  const people = snapshot.users.filter((user) => user.status !== 'deactivated');

  function assign() {
    if (!userId) return;
    void apply(null, () =>
      // snake_case, because the wire is snake_case: the service runs Jackson with SNAKE_CASE,
      // so a camelCase key does not bind and arrives as null. That is not a compile error on
      // either side — it fails at run time with a message about the missing value.
      send<Snapshot>('/api/v1/owners', 'POST', {
        scope_type: scopeType,
        scope_id: scopeId,
        role_id: roleId || null,
        user_id: userId,
      }),
    ).then((result) => {
      if (result) setUserId('');
    });
  }

  return (
    <>
      <SectionHeading>{heading}</SectionHeading>
      <Blueprint padded={false}>
        {groups.length === 0 ? (
          <EmptyRow>
            Nobody owns this {scopeLabel[scopeType]} yet. The overall owner is the one name to ask
            when you do not know whose problem it is; the rest are per team.
          </EmptyRow>
        ) : null}

        {groups.map((group) => (
          <div
            key={group.role_id ?? 'overall'}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              borderBottom: '1px solid var(--color-divider)',
            }}
          >
            <span
              className="kicker"
              style={{ width: 120, flex: 'none', fontSize: 11, letterSpacing: '.09em' }}
            >
              {group.label}
            </span>
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--space-2)',
                minWidth: 0,
              }}
            >
              {group.people.map((person) => (
                <span
                  key={person.owner_id}
                  title={person.email}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    padding: '1px 8px',
                    border: '1px solid var(--color-neutral-400)',
                    background: group.role_id ? 'transparent' : 'var(--color-accent-100)',
                  }}
                >
                  {person.display_name}
                  <button
                    type="button"
                    className="mono"
                    disabled={!canEdit}
                    title={
                      canEdit
                        ? `Remove ${person.display_name} from ${group.label}`
                        : reasonFor('module.edit')
                    }
                    onClick={() =>
                      void apply(null, () =>
                        send<Snapshot>(`/api/v1/owners/${person.owner_id}`, 'DELETE'),
                      )
                    }
                    style={{
                      border: 0,
                      background: 'transparent',
                      padding: 0,
                      cursor: canEdit ? 'pointer' : 'not-allowed',
                      color: 'var(--color-neutral-600)',
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        ))}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            assign();
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
            style={{ width: 150 }}
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
            aria-label="Team"
          >
            {/* Overall first, and the default. It is the row people look for. */}
            <option value="">Overall owner</option>
            {teams.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ flex: 1, minWidth: 160 }}
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            aria-label="Person"
          >
            <option value="">Choose somebody…</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.display_name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={!canEdit || !userId}
            title={canEdit ? undefined : reasonFor('module.edit')}
          >
            Add owner
          </button>
        </form>
      </Blueprint>
      <div
        style={{
          marginTop: 'var(--space-2)',
          fontSize: 11,
          color: 'var(--color-neutral-600)',
          textWrap: 'pretty',
        }}
      >
        An owner is a real account, not a typed-in name — which is what makes it possible to tell
        them anything. The teams are this project&apos;s roles: hide a role on the Access screen
        and its row disappears from here.
      </div>
    </>
  );
}
