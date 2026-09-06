'use client';

import { useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, PageTitle, SectionHeading } from '@/components/primitives';
import { send } from '@/lib/client/api';
import { PERMISSION_GROUPS, PERMISSION_LABELS, type PermissionKey } from '@/lib/shared/permissions';
import type { Snapshot } from '@/lib/shared/views';

/**
 * Access — the whole model in one screen: who sits where, who is invited, and exactly
 * what each role may do.
 *
 * The grid writes back. Toggling a cell is a role edit, and the server refuses to grant
 * a permission the actor does not hold themselves.
 */

const HIERARCHY = [
  {
    level: 'Platform',
    who: 'Super admin',
    can: 'Creates organisations and onboards their first admin. Never touches project data.',
  },
  {
    level: 'Organisation',
    who: 'Admin',
    can: 'Owns one or more projects, onboards sub-admins, defines roles and their permissions.',
  },
  {
    level: 'Delegated',
    who: 'Sub-admin',
    can: 'Same powers as the admin, or a narrower set — the admin decides per role.',
  },
  {
    level: 'Project',
    who: 'Custom roles',
    can: 'Any mix of permissions: who may create modules, update deliverables, sign off FNI, log defects.',
  },
];

export default function AccessPage() {
  const { snapshot, apply, can, reasonFor, setNotice } = useTracker();
  const { roles, users, members, invitations, projects, org } = snapshot;

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [scope, setScope] = useState('org');
  const [memberUserId, setMemberUserId] = useState('');
  const [memberRoleId, setMemberRoleId] = useState(roles[0]?.id ?? '');

  const canManageRoles = can('admin.roles.manage');
  const canManageUsers = can('admin.users.manage');
  const canManageMembers = can('project.members.manage');

  // Only people who cannot already reach the project — an org-wide membership covers it.
  const alreadyHere = new Set(members.map((member) => member.user_id));
  const addable = users.filter((user) => !alreadyHere.has(user.id));

  const selectedRole = roles.find((role) => role.id === roleId);
  const previewLabels = selectedRole
    ? selectedRole.permissions.map((key) => PERMISSION_LABELS[key])
    : [];
  const preview = selectedRole
    ? `${previewLabels.length} ${previewLabels.length === 1 ? 'permission' : 'permissions'}: ${previewLabels
        .slice(0, 5)
        .join(', ')}${previewLabels.length > 5 ? `, +${previewLabels.length - 5} more` : ''}`
    : '';

  async function sendInvitation() {
    if (!email.trim() || !roleId) return;
    const meta = await apply(null, () =>
      send<Snapshot>('/api/v1/invitations', 'POST', {
        email,
        display_name: displayName,
        role_id: roleId,
        scope_project_id: scope === 'org' ? null : scope,
      }),
    );
    if (meta?.accept_url) {
      setEmail('');
      setDisplayName('');
      // The link is surfaced whatever the transport did: it is single-use and it works,
      // and a delivery that only logged would otherwise leave the admin with nothing.
      const link = `${window.location.origin}${meta.accept_url}`;
      setNotice(
        meta.delivery_state === 'sent'
          ? `Invitation sent. ${String(meta.delivery_detail)} The link, if you need it: ${link}`
          : `Invitation created. ${String(meta.delivery_detail)} Send them this single-use link: ${link}`,
      );
    }
  }

  function toggle(role: (typeof roles)[number], permission: PermissionKey) {
    if (!canManageRoles) {
      setNotice(reasonFor('admin.roles.manage'));
      return;
    }
    const granted = !role.permissions.includes(permission);
    void apply(
      (current) => ({
        ...current,
        roles: current.roles.map((candidate) =>
          candidate.id === role.id
            ? {
                ...candidate,
                permissions: granted
                  ? [...candidate.permissions, permission]
                  : candidate.permissions.filter((key) => key !== permission),
              }
            : candidate,
        ),
      }),
      () => send<Snapshot>(`/api/v1/roles/${role.id}/grants`, 'PATCH', { permission, granted }),
    );
  }

  return (
    <div className="page">
      <PageTitle
        title="Access"
        lede="Super admin onboards an admin. An admin owns projects and can onboard sub-admins, and either can define new roles with any mix of permissions."
      />

      <div
        className="bordered"
        style={{ display: 'flex', alignItems: 'stretch', marginBottom: 'var(--space-8)', flexWrap: 'wrap' }}
      >
        {HIERARCHY.map((entry) => (
          <div
            key={entry.level}
            style={{
              flex: '1 1 200px',
              padding: 'var(--space-4)',
              borderRight: '1px solid var(--color-divider)',
            }}
          >
            <div className="kicker" style={{ letterSpacing: '.11em' }}>
              {entry.level}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-heading)',
                fontWeight: 600,
                fontSize: 19,
                marginTop: 2,
              }}
            >
              {entry.who}
            </div>
            <div
              style={{
                fontSize: 12,
                color: 'var(--color-neutral-700)',
                marginTop: 'var(--space-1)',
                textWrap: 'pretty',
              }}
            >
              {entry.can}
            </div>
          </div>
        ))}
      </div>

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
            Onboard a user
          </h4>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
            an invitation is created; the user sets their own password
          </span>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void sendInvitation();
          }}
          style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}
        >
          <input
            className="input"
            style={{ width: 220 }}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@nokia.com"
            aria-label="Email"
          />
          <input
            className="input"
            style={{ width: 170 }}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Display name"
            aria-label="Display name"
          />
          <select
            className="input"
            style={{ width: 150 }}
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
            aria-label="Role"
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ width: 230 }}
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            aria-label="Scope"
          >
            <option value="org">{org.name} — all projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.key}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canManageUsers}
            title={canManageUsers ? undefined : reasonFor('admin.users.manage')}
          >
            Send invitation
          </button>
        </form>

        <div
          style={{
            marginTop: 'var(--space-3)',
            fontSize: 12,
            color: 'var(--color-neutral-700)',
            textWrap: 'pretty',
          }}
        >
          {preview}
        </div>

        <div style={{ marginTop: 'var(--space-6)', borderTop: '1px solid var(--color-divider)' }}>
          {invitations.map((invitation) => (
            <div
              key={invitation.id}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 'var(--space-3)',
                padding: 'var(--space-2) 0',
                borderBottom: '1px solid var(--color-divider)',
                flexWrap: 'wrap',
              }}
            >
              <span className="mono" style={{ fontSize: 12, width: 190, flex: 'none' }}>
                {invitation.email}
              </span>
              <span style={{ fontSize: 13, width: 110, flex: 'none' }}>
                {invitation.display_name}
              </span>
              <span className="tag tag-accent" style={{ flex: 'none' }}>
                {invitation.role_name}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--color-neutral-700)',
                  flex: 1,
                  minWidth: 120,
                }}
              >
                {invitation.scope}
              </span>
              <span style={{ fontSize: 12, color: 'var(--color-neutral-600)', flex: 'none' }}>
                {invitation.state}
              </span>
            </div>
          ))}
        </div>
      </Blueprint>

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
            Roles &amp; permissions
          </h4>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
            {canManageRoles ? 'click a cell to grant or revoke' : reasonFor('admin.roles.manage')}
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ minWidth: 250 }}>Permission</th>
                {roles.map((role) => (
                  <th key={role.id} style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                    {role.name}
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 400,
                        textTransform: 'none',
                        letterSpacing: 0,
                        color: 'var(--color-neutral-600)',
                      }}
                    >
                      {role.note}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            {PERMISSION_GROUPS.map((group) => (
              <tbody key={group.label}>
                <tr>
                  <td
                    colSpan={roles.length + 1}
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 13,
                      letterSpacing: '.11em',
                      textTransform: 'uppercase',
                      color: 'var(--color-neutral-600)',
                      background: 'var(--color-accent-100)',
                    }}
                  >
                    {group.label}
                  </td>
                </tr>
                {group.keys.map((key) => (
                  <tr key={key}>
                    <td style={{ fontSize: 13 }}>
                      {PERMISSION_LABELS[key]}
                      <div className="mono" style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}>
                        {key}
                      </div>
                    </td>
                    {roles.map((role) => {
                      const granted = role.permissions.includes(key);
                      return (
                        <td key={role.id} style={{ textAlign: 'center', padding: 'var(--space-1)' }}>
                          <button
                            type="button"
                            onClick={() => toggle(role, key)}
                            disabled={!canManageRoles}
                            aria-pressed={granted}
                            aria-label={`${PERMISSION_LABELS[key]} for ${role.name}`}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 24,
                              height: 24,
                              padding: 0,
                              cursor: canManageRoles ? 'pointer' : 'not-allowed',
                              fontSize: 12,
                              borderRadius: 0,
                              border: '1px solid var(--color-neutral-400)',
                              background: granted ? 'var(--color-accent)' : 'transparent',
                              color: granted ? 'var(--color-bg)' : 'var(--color-neutral-500)',
                              opacity: canManageRoles ? 1 : 0.6,
                            }}
                          >
                            {granted ? '✓' : '–'}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </Blueprint>

      <SectionHeading first>Members of {snapshot.project.key}</SectionHeading>
      <div style={{ marginBottom: 'var(--space-3)', fontSize: 12, color: 'var(--color-neutral-700)', textWrap: 'pretty' }}>
        Who can open this project. Organisation-wide access applies to every project, so it is
        listed here but changed above. Nobody can give out a role holding more than they do
        themselves, and nobody can change their own access.
      </div>

      <div className="bordered" style={{ overflowX: 'auto', marginBottom: 'var(--space-4)' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role on this project</th>
              <th>Scope</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.membership_id}>
                <td style={{ whiteSpace: 'nowrap' }}>{member.display_name}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {member.email}
                </td>
                <td>
                  <select
                    className="input"
                    style={{ width: 150, padding: '2px 6px', fontSize: 12 }}
                    value={member.role_id}
                    disabled={!canManageMembers || !member.editable}
                    title={
                      canManageMembers
                        ? member.locked_reason || `Change what ${member.display_name} may do here`
                        : reasonFor('project.members.manage')
                    }
                    aria-label={`Role for ${member.display_name}`}
                    onChange={(event) =>
                      void apply(null, () =>
                        send<Snapshot>(`/api/v1/projects/members/${member.membership_id}`, 'PATCH', {
                          role_id: event.target.value,
                        }),
                      )
                    }
                  >
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                  {member.org_wide ? `${org.name} — all projects` : snapshot.project.key}
                </td>
                <td>
                  <button
                    type="button"
                    disabled={!canManageMembers || !member.editable}
                    title={
                      canManageMembers
                        ? member.locked_reason || `Remove ${member.display_name} from this project`
                        : reasonFor('project.members.manage')
                    }
                    onClick={() =>
                      void apply(null, () =>
                        send<Snapshot>(
                          `/api/v1/projects/members/${member.membership_id}`,
                          'DELETE',
                        ),
                      )
                    }
                    style={{
                      fontSize: 12,
                      color: 'var(--color-neutral-600)',
                      border: 0,
                      background: 'transparent',
                      cursor: canManageMembers && member.editable ? 'pointer' : 'not-allowed',
                    }}
                  >
                    remove
                  </button>
                </td>
              </tr>
            ))}
            {members.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ fontSize: 13, color: 'var(--color-neutral-600)' }}>
                  Nobody has access to this project yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!memberUserId) return;
          void apply(null, () =>
            send<Snapshot>('/api/v1/projects/members', 'POST', {
              user_id: memberUserId,
              role_id: memberRoleId,
            }),
          );
        }}
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: 'var(--space-8)',
        }}
      >
        <select
          className="input"
          style={{ width: 230 }}
          value={memberUserId}
          onChange={(event) => setMemberUserId(event.target.value)}
          aria-label="User to add to this project"
        >
          <option value="">Someone already in {org.name}…</option>
          {addable.map((user) => (
            <option key={user.id} value={user.id}>
              {user.display_name} — {user.email}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ width: 150 }}
          value={memberRoleId}
          onChange={(event) => setMemberRoleId(event.target.value)}
          aria-label="Role for the new member"
        >
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={!canManageMembers || addable.length === 0}
          title={
            canManageMembers
              ? addable.length === 0
                ? 'Everyone in the organisation already has access to this project'
                : undefined
              : reasonFor('project.members.manage')
          }
        >
          Add to project
        </button>
        <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
          Someone not in {org.name} yet is invited above instead.
        </span>
      </form>

      <SectionHeading first>Users in this organisation</SectionHeading>
      <div className="bordered" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Scope</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{user.display_name}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {user.email}
                </td>
                <td>
                  <span className="tag tag-accent">{user.role_name}</span>
                </td>
                <td style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>{user.scope}</td>
                <td style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{user.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
