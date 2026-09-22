'use client';

import { useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, PageTitle, SectionHeading } from '@/components/primitives';
import { RolesPanel } from '@/components/access/RolesPanel';
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
    can: 'Any mix of permissions: who may create sub-modules, update deliverables, sign off FNI, log defects.',
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
  const [orgGrantRoleId, setOrgGrantRoleId] = useState(roles[0]?.id ?? '');

  /**
   * A super admin can always edit roles, even holding no permission at all.
   *
   * This is the client half of the repair route in `AccessUseCases.setRolePermission`. A role
   * wiped by the old grants endpoint takes `admin.roles.manage` with it, and without this the
   * grid would sit disabled for the one account able to put it back — a server that allows the
   * call and a screen that will not make it is the same as no fix.
   */
  const canManageRoles = can('admin.roles.manage') || snapshot.me.is_super_admin;
  const canManageUsers = can('admin.users.manage');
  const canManageMembers = can('project.members.manage');

  /**
   * Who may change who belongs to the organisation.
   *
   * Deliberately `admin.users.manage`, not `project.members.manage`. A project administrator
   * administers a project; ending somebody's access to every project at once is a different job
   * with a different blast radius, and the service enforces exactly this — see
   * `AccessUseCases.removeFromOrganisation`. The super admin is folded in because the flag is
   * set outside the application and grants no permission key on its own.
   */
  const canManageOrg = canManageUsers || snapshot.me.is_super_admin;

  // Only people who cannot already reach the project — an org-wide membership covers it.
  const alreadyHere = new Set(members.map((member) => member.user_id));
  const addable = users.filter((user) => !alreadyHere.has(user.id));

  // Hidden roles are not offered anywhere. They are still in `roles` because rows already
  // pointing at one have to render with a name rather than an id.
  const liveRoles = roles.filter((role) => !role.hidden);
  const selectedRole = roles.find((role) => role.id === roleId);
  const previewLabels = selectedRole
    ? selectedRole.permissions.map((key) => PERMISSION_LABELS[key])
    : [];
  const preview = selectedRole
    ? `${previewLabels.length} ${previewLabels.length === 1 ? 'permission' : 'permissions'}: ${previewLabels
        .slice(0, 5)
        .join(', ')}${previewLabels.length > 5 ? `, +${previewLabels.length - 5} more` : ''}`
    : '';


  /**
   * Starts a password reset for somebody else.
   *
   * Nobody sets anybody's password: the server issues a single-use link and the person chooses
   * their own. So the link is the whole product of this action, it is shown once, and it cannot
   * be recovered afterwards — the server keeps only a one-way hash of it. Hence the confirm
   * before, and the notice that has to be read rather than dismissed.
   */
  async function resetPassword(userId: string, who: string) {
    if (
      !window.confirm(
        `Issue a password reset link for ${who}?\n\nTheir current password keeps working until they use the link. Any earlier link stops working now.`,
      )
    ) {
      return;
    }

    const meta = await apply(null, () =>
      send<Snapshot>(`/api/v1/users/${userId}/reset-password`, 'POST'),
    );
    if (!meta?.reset_url) return;

    // "Copy it before dismissing this" used to be literally true, and it was a bad promise to
    // have to make: dismiss the banner and the link was gone for good, repairable only by
    // issuing another one and invalidating the first. The same link is now in the issuer's own
    // inbox, so the banner can say where it went instead of demanding the reader act now.
    setNotice(
      `Password reset for ${meta.display_name}. ${meta.delivery_detail ?? ''} It works once and expires in seven days. The link is in your inbox (⚿, top right) if you need it again: ${meta.reset_url}`,
    );
  }

  /**
   * Corrects somebody's display name.
   *
   * The name only. The email address is the login identity, so changing it is an account
   * migration rather than an edit and is deliberately not offered here.
   */
  async function renameUser(userId: string, current: string, email: string) {
    const next = window.prompt(`Name for ${email}`, current);
    if (next === null) return;
    if (!next.trim() || next.trim() === current) return;

    await apply(null, () =>
      send<Snapshot>(`/api/v1/users/${userId}`, 'PATCH', { display_name: next.trim() }),
    );
  }

  /**
   * Ends somebody's access to the whole organisation.
   *
   * The confirm spells out the difference from the button in the table above, because both read
   * "remove" and they are not degrees of the same act. It also says what does *not* happen — the
   * account is deactivated, not deleted, so their name stays on the comments, ticks and defects
   * that carry it. A "delete" that left rows pointing at nothing would be the other option and is
   * not one this application takes anywhere.
   */
  async function removeFromOrg(userId: string, who: string) {
    if (
      !window.confirm(
        `Remove ${who} from ${org.name}?\n\nThis is not the same as removing them from a project. Every membership they hold goes, across every project, and they can no longer sign in.\n\nTheir name stays on the comments, ticks and defects they made — the account is deactivated, not deleted, and you can restore it here.`,
      )
    ) {
      return;
    }

    await apply(null, () =>
      send<Snapshot>(`/api/v1/organisation/members/user/${userId}`, 'DELETE'),
    );
  }

  /** Lets a removed account sign in again. It comes back with nothing — access is granted separately. */
  async function restoreUser(userId: string, who: string) {
    if (
      !window.confirm(
        `Let ${who} sign in to ${org.name} again?\n\nThey come back with no access to any project. Whatever they had before is gone and has to be granted again — nobody stored it, on purpose.`,
      )
    ) {
      return;
    }

    await apply(null, () =>
      send<Snapshot>(`/api/v1/organisation/members/user/${userId}/restore`, 'POST'),
    );
  }

  /** One role on every project, including projects nobody has created yet. */
  async function grantOrgWide(userId: string, who: string) {
    if (!orgGrantRoleId) return;
    const role = roles.find((candidate) => candidate.id === orgGrantRoleId)?.name ?? 'that role';

    if (
      !window.confirm(
        `Give ${who} ${role} on every project in ${org.name}?\n\nThis includes projects that do not exist yet. It is in addition to any access they already have on individual projects, never instead of it.`,
      )
    ) {
      return;
    }

    await apply(null, () =>
      send<Snapshot>('/api/v1/organisation/members', 'POST', {
        user_id: userId,
        role_id: orgGrantRoleId,
      }),
    );
  }

  /** Takes away the org-wide row only. Per-project memberships are untouched, and the confirm says so. */
  async function revokeOrgWide(who: string, membershipId: string) {
    if (
      !window.confirm(
        `Take away ${who}'s organisation-wide access?\n\nAny access they hold on individual projects is kept — this removes only the role that applies to every project. They stay in ${org.name}.`,
      )
    ) {
      return;
    }

    await apply(null, () =>
      send<Snapshot>(`/api/v1/organisation/members/${membershipId}`, 'DELETE'),
    );
  }

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
      //
      // Used as sent. The server builds it from MTMS_APP_BASE_URL — the setting that exists
      // because the service cannot see its own public address behind a proxy — so prefixing
      // the page's origin here is what produced links carrying the domain twice.
      const link = String(meta.accept_url);
      setNotice(
        meta.delivery_state === 'sent'
          ? `Invitation sent. ${String(meta.delivery_detail)} The link is also in your inbox (⚿, top right): ${link}`
          : `Invitation created. ${String(meta.delivery_detail)} Send them this single-use link — it is in your inbox (⚿, top right) too: ${link}`,
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
            placeholder="name@mail.com"
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
            {liveRoles.map((role) => (
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

      {/*
        Which roles exist sits above what they can do, because that is the order the decisions
        get made in: a team decides it needs a Field Engineer before it decides what one may do.
      */}
      <RolesPanel />

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
                {liveRoles.map((role) => (
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
                    {liveRoles.map((role) => {
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
        listed here and changed in the organisation table below. Nobody can give out a role
        holding more than they do themselves, and nobody can change their own access.
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
                    {liveRoles.map((role) => (
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
                        ? member.locked_reason ||
                          `Remove ${member.display_name} from ${snapshot.project.key} only — they stay in ${org.name}`
                        : reasonFor('project.members.manage')
                    }
                    onClick={() => {
                      // Named because the same word appears twice on this screen and means two
                      // different things. This one is the small version, and saying so is what
                      // stops somebody clicking it expecting the other.
                      if (
                        !window.confirm(
                          `Remove ${member.display_name} from ${snapshot.project.key}?\n\nThey stay in ${org.name} and keep every other project. Add them back here at any time.`,
                        )
                      ) {
                        return;
                      }
                      void apply(null, () =>
                        send<Snapshot>(
                          `/api/v1/projects/members/${member.membership_id}`,
                          'DELETE',
                        ),
                      );
                    }}
                    style={{
                      fontSize: 12,
                      color: 'var(--color-neutral-600)',
                      border: 0,
                      background: 'transparent',
                      cursor: canManageMembers && member.editable ? 'pointer' : 'not-allowed',
                    }}
                  >
                    remove from project
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
          {liveRoles.map((role) => (
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

      <SectionHeading first>Members of {org.name}</SectionHeading>
      <div
        style={{
          marginBottom: 'var(--space-3)',
          fontSize: 12,
          color: 'var(--color-neutral-700)',
          textWrap: 'pretty',
        }}
      >
        Everybody with an account in this organisation, whichever projects they are on.{' '}
        <strong>This is not the table above.</strong> Removing somebody from{' '}
        {snapshot.project.key} takes them off that project and leaves the account alone; removing
        them here ends every membership they hold and they can no longer sign in. The first is a
        project administrator&rsquo;s job and the second is an organisation
        administrator&rsquo;s, which is why they need different permissions.
      </div>

      {canManageOrg ? (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            marginBottom: 'var(--space-3)',
            fontSize: 12,
            color: 'var(--color-neutral-700)',
          }}
        >
          {/*
            The role a Grant org-wide button will use, chosen once for the table rather than
            asked for per row. A prompt per click would be four dialogs to put four people on
            the same footing, and the answer is the same every time.
          */}
          Grant organisation-wide access as
          <select
            className="input"
            style={{ width: 150, padding: '2px 6px', fontSize: 12 }}
            value={orgGrantRoleId}
            onChange={(event) => setOrgGrantRoleId(event.target.value)}
            aria-label="Role for a new organisation-wide grant"
          >
            {liveRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="bordered" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Across the organisation</th>
              <th>Projects</th>
              <th>State</th>
              {canManageOrg ? <th>Password</th> : null}
              {canManageOrg ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const removed = user.status === 'removed';
              // Absent, not null — the service omits null fields entirely, so `== null`
              // catches both spellings and `!== null` would have been true for `undefined`.
              const orgWide = user.org_wide_membership_id == null ? null : user.org_wide_membership_id;

              return (
                <tr key={user.id} style={removed ? { opacity: 0.55 } : undefined}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {user.display_name}
                    {user.super_admin ? (
                      <span
                        className="tag"
                        style={{ marginLeft: 6, fontSize: 10 }}
                        title="Platform super administrator — set outside the application; no screen grants it"
                      >
                        super
                      </span>
                    ) : null}
                    {/*
                      Only where the name is worth correcting. Several accounts carry an email
                      address as their name because the console did not ask for one until 18 Sept,
                      and nothing could change it until this existed.
                    */}
                    {canManageUsers && !removed ? (
                      <button
                        type="button"
                        title={`Rename ${user.email}`}
                        aria-label={`Rename ${user.email}`}
                        onClick={() => void renameUser(user.id, user.display_name, user.email)}
                        style={{
                          marginLeft: 6,
                          border: 0,
                          background: 'transparent',
                          padding: 0,
                          cursor: 'pointer',
                          fontSize: 11,
                          color: 'var(--color-neutral-600)',
                        }}
                      >
                        edit
                      </button>
                    ) : null}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {user.email}
                  </td>

                  {/*
                    Organisation-wide access, which is the one grant that cannot be seen from any
                    project screen — it reaches every project including ones that do not exist
                    yet. Before this column, it could be handed out (by an invitation, or from the
                    super admin console) and then never found again.
                  */}
                  <td>
                    {orgWide ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <select
                          className="input"
                          style={{ width: 140, padding: '2px 6px', fontSize: 12 }}
                          value={user.org_wide_role_id ?? ''}
                          disabled={!canManageOrg || user.id === snapshot.me.user_id}
                          title={
                            user.id === snapshot.me.user_id
                              ? 'You cannot change your own access'
                              : canManageOrg
                                ? `${user.display_name} has this role on every project`
                                : reasonFor('admin.users.manage')
                          }
                          aria-label={`Organisation-wide role for ${user.display_name}`}
                          onChange={(event) =>
                            void apply(null, () =>
                              send<Snapshot>(
                                `/api/v1/organisation/members/${orgWide}`,
                                'PATCH',
                                { role_id: event.target.value },
                              ),
                            )
                          }
                        >
                          {liveRoles.map((role) => (
                            <option key={role.id} value={role.id}>
                              {role.name}
                            </option>
                          ))}
                        </select>
                        {canManageOrg && user.id !== snapshot.me.user_id ? (
                          <button
                            type="button"
                            title={`Take away ${user.display_name}'s access to every project. Any single-project access they hold is kept.`}
                            onClick={() => void revokeOrgWide(user.display_name, orgWide)}
                            style={LINK_BUTTON}
                          >
                            revoke
                          </button>
                        ) : null}
                      </span>
                    ) : canManageOrg && !removed ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: 12, padding: '2px 10px' }}
                        title={`Give ${user.display_name} one role on every project, including projects created later`}
                        onClick={() => void grantOrgWide(user.id, user.display_name)}
                      >
                        Grant org-wide
                      </button>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
                        per project
                      </span>
                    )}
                  </td>

                  <td style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>
                    {user.project_count === 0 ? (
                      <span style={{ color: 'var(--color-neutral-600)' }}>
                        {orgWide ? 'every project' : 'none'}
                      </span>
                    ) : (
                      <span title={user.scope}>
                        {user.project_count} {user.project_count === 1 ? 'project' : 'projects'}
                        {orgWide ? ' + every project' : ''}
                      </span>
                    )}
                  </td>

                  <td style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
                    {user.status}
                  </td>

                  {canManageOrg ? (
                    <td>
                      {/*
                        Only for somebody with a password to reset. An invited account has none
                        yet — that case is a reissued invitation, and the server says so rather
                        than pretending the two are the same thing.
                      */}
                      {user.status === 'active' ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: 12, padding: '2px 10px' }}
                          title={`Issue a single-use link for ${user.email} to choose a new password`}
                          onClick={() => void resetPassword(user.id, user.display_name)}
                        >
                          Reset
                        </button>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>—</span>
                      )}
                    </td>
                  ) : null}

                  {canManageOrg ? (
                    <td>
                      {removed ? (
                        <button
                          type="button"
                          title={`Let ${user.display_name} sign in again. They come back with no access — grant it separately.`}
                          onClick={() => void restoreUser(user.id, user.display_name)}
                          style={LINK_BUTTON}
                        >
                          restore
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={!user.removable}
                          title={
                            user.locked_reason ??
                            `Remove ${user.display_name} from ${org.name} entirely`
                          }
                          onClick={() => void removeFromOrg(user.id, user.display_name)}
                          style={{
                            ...LINK_BUTTON,
                            cursor: user.removable ? 'pointer' : 'not-allowed',
                            opacity: user.removable ? 1 : 0.5,
                          }}
                        >
                          remove from {org.name}
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!canManageOrg ? (
        <div
          style={{
            marginTop: 'var(--space-3)',
            fontSize: 12,
            color: 'var(--color-neutral-600)',
            textWrap: 'pretty',
          }}
        >
          {reasonFor('admin.users.manage')} — an organisation administrator or a super admin
          changes who belongs to {org.name}.
        </div>
      ) : null}
    </div>
  );
}

/** A control that reads as a link. Used for the destructive ones, which should not look inviting. */
const LINK_BUTTON = {
  fontSize: 12,
  color: 'var(--color-neutral-600)',
  border: 0,
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const;
