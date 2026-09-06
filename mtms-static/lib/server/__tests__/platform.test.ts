import { beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../auth';
import {
  buildPlatformView,
  createOrganisation,
  createOrganisationProject,
  isSuperAdmin,
  setOrganisationStatus,
} from '../platform';
import { getStore, mutate } from '../store';
import { ADMIN, DEVOPS, VIEWER, actorFor, refused, useSeededStore } from './harness';

/**
 * The super admin — the level above an organisation.
 *
 * Two properties matter more than the features, and both have tests here rather than
 * comments: it cannot be granted from inside an organisation, and it never reads or
 * writes project data.
 */

beforeEach(useSeededStore);

describe('who is a super admin', () => {
  it('is the seeded platform owner, and nobody else', async () => {
    const store = await getStore();
    expect(isSuperAdmin(store, await actorFor(ADMIN))).toBe(true);
    expect(isSuperAdmin(store, await actorFor(DEVOPS))).toBe(false);
    expect(isSuperAdmin(store, await actorFor(VIEWER))).toBe(false);
  });

  it('is not one of the permission keys', async () => {
    // The whole point: permissions are granted by roles an organisation's own admin can
    // edit. If this were a key, any admin could grant it to themselves and mint
    // organisations. Guard the invariant, not just today's role list.
    const store = await getStore();
    for (const role of store.roles) {
      expect(role.permissions).not.toContain('platform.manage');
      expect(role.permissions.some((key) => key.startsWith('platform.'))).toBe(false);
    }
  });

  it('refuses an organisation admin who is not the platform owner', async () => {
    // The Sub-admin holds nearly every permission inside Flow One. That must not be enough.
    const subAdmin = await actorFor('a.iyer@mahajan.com');
    await refused(
      createOrganisation(subAdmin, { name: 'Someone Else', adminEmail: 'a@b.com' }),
      'forbidden',
    );
  });

  it('does not tell an ordinary user that super admin exists', async () => {
    const error = await refused(
      createOrganisation(await actorFor(VIEWER), { name: 'X', adminEmail: 'a@b.com' }),
      'forbidden',
    );
    expect(error.message).toBe('That is not available to your account.');
    expect(error.message.toLowerCase()).not.toContain('super');
  });

  it('refuses to read the platform view too, not just to write', async () => {
    const store = await getStore();
    const viewer = await actorFor(VIEWER);
    expect(() => buildPlatformView(store, viewer)).toThrow();
  });
});

describe('creating an organisation', () => {
  async function create(name = 'Northern Grid', adminEmail = 'lead@mahajan.com') {
    return createOrganisation(await actorFor(ADMIN), { name, adminEmail, adminName: 'A. Lead' });
  }

  it('creates the organisation, its roles and an invited admin in one go', async () => {
    const { tenant, adminEmail } = await create();
    const store = await getStore();

    // An organisation with no roles cannot have members; one with no admin cannot be
    // administered. All three or none.
    expect(store.tenants.find((candidate) => candidate.id === tenant.id)?.name).toBe('Northern Grid');
    expect(store.roles.filter((role) => role.tenant_id === tenant.id)).toHaveLength(7);

    const admin = store.users.find((user) => user.email === adminEmail);
    expect(admin?.tenant_id).toBe(tenant.id);
    expect(admin?.status).toBe('invited');
    expect(admin?.password_hash).toBe('');
  });

  it('gives the first admin organisation-wide access, so they own projects made later', async () => {
    const { tenant, adminEmail } = await create();
    const store = await getStore();

    const admin = store.users.find((user) => user.email === adminEmail)!;
    const membership = store.memberships.find((row) => row.user_id === admin.id)!;
    const role = store.roles.find((candidate) => candidate.id === membership.role_id)!;

    expect(membership.project_id).toBeNull();
    expect(membership.tenant_id).toBe(tenant.id);
    expect(role.key).toBe('admin');
  });

  it('never sets a password — the admin arrives by invitation like everyone else', async () => {
    const { inviteToken, adminEmail } = await create();
    const store = await getStore();
    const admin = store.users.find((user) => user.email === adminEmail)!;

    expect(admin.invite_token_hash).toBe(hashToken(inviteToken));
    expect(admin.invite_expires_at).not.toBeNull();
  });

  it('does not make the new admin a super admin', async () => {
    const { adminEmail } = await create();
    const store = await getStore();
    expect(store.users.find((user) => user.email === adminEmail)?.is_super_admin).toBe(false);
  });

  it('derives a slug from the name, and refuses a duplicate one', async () => {
    const { tenant } = await create();
    expect(tenant.slug).toBe('northern-grid');

    await refused(create('Northern  Grid', 'other@mahajan.com'), 'conflict');
  });

  it('refuses a name-less organisation and a non-email admin', async () => {
    const actor = await actorFor(ADMIN);
    await refused(createOrganisation(actor, { name: '   ', adminEmail: 'a@b.com' }), 'validation_failed');
    await refused(createOrganisation(actor, { name: 'Fine', adminEmail: 'nope' }), 'validation_failed');
  });

  it('starts with no projects — the platform creates the shell, not the process', async () => {
    const { tenant } = await create();
    const store = await getStore();
    expect(store.projects.filter((project) => project.tenant_id === tenant.id)).toHaveLength(0);
  });

  it('records the action in the platform log, not in any project audit', async () => {
    const before = (await getStore()).audit.length;
    await create();
    const store = await getStore();

    expect(store.platform_audit[0]?.action).toBe('organisation.created');
    // Platform events must not appear in an organisation's own change feed.
    expect(store.audit).toHaveLength(before);
  });
});

describe('creating a project inside an organisation', () => {
  it('creates it empty, so the owning team defines its own process', async () => {
    const actor = await actorFor(ADMIN);
    const { tenant } = await createOrganisation(actor, {
      name: 'Northern Grid',
      adminEmail: 'lead@mahajan.com',
    });

    const { projectId, key } = await createOrganisationProject(actor, tenant.id, {
      key: 'cmdb_sync',
    });
    const store = await getStore();
    const project = store.projects.find((candidate) => candidate.id === projectId)!;

    expect(key).toBe('CMDB_SYNC');
    expect(project.configured).toBe(false);
    // No columns, node types or stages: a platform operator pre-filling them would be
    // deciding another team's process for them.
    expect(store.columns.filter((column) => column.project_id === projectId)).toHaveLength(0);
    const config = store.project_config.find((entry) => entry.project_id === projectId)!;
    expect(config.node_types).toEqual([]);
    expect(config.stages).toEqual([]);
  });

  it('refuses a key that is not a project key', async () => {
    const actor = await actorFor(ADMIN);
    const store = await getStore();
    const tenantId = store.tenants[0]!.id;

    await refused(createOrganisationProject(actor, tenantId, { key: '9lives' }), 'validation_failed');
    await refused(createOrganisationProject(actor, tenantId, { key: 'has spaces' }), 'validation_failed');
  });

  it('refuses a duplicate key in the same organisation, and allows it in another', async () => {
    const actor = await actorFor(ADMIN);
    const store = await getStore();
    const flowOne = store.tenants[0]!.id;

    await refused(createOrganisationProject(actor, flowOne, { key: 'CR_AUTOMATION' }), 'conflict');

    const { tenant } = await createOrganisation(actor, {
      name: 'Northern Grid',
      adminEmail: 'lead@mahajan.com',
    });
    // The same key in a different organisation is a different project entirely.
    const created = await createOrganisationProject(actor, tenant.id, { key: 'CR_AUTOMATION' });
    expect(created.key).toBe('CR_AUTOMATION');
  });

  it('refuses an organisation that does not exist', async () => {
    await refused(
      createOrganisationProject(await actorFor(ADMIN), '00000000-0000-4000-8000-000000000000', {
        key: 'X_Y',
      }),
      'not_found',
    );
  });
});

describe('suspending an organisation', () => {
  it('changes status without deleting anything', async () => {
    const actor = await actorFor(ADMIN);
    const { tenant } = await createOrganisation(actor, {
      name: 'Northern Grid',
      adminEmail: 'lead@mahajan.com',
    });
    await createOrganisationProject(actor, tenant.id, { key: 'CMDB' });

    await setOrganisationStatus(actor, tenant.id, 'suspended');
    const store = await getStore();

    expect(store.tenants.find((candidate) => candidate.id === tenant.id)?.status).toBe('suspended');
    // The record of what happened there survives being switched off.
    expect(store.projects.filter((project) => project.tenant_id === tenant.id)).toHaveLength(1);
    expect(store.users.filter((user) => user.tenant_id === tenant.id)).toHaveLength(1);
  });

  it('refuses to suspend the operator’s own organisation', async () => {
    const actor = await actorFor(ADMIN);
    const store = await getStore();
    const own = store.users.find((user) => user.id === actor.userId)!.tenant_id;

    // Locking yourself out is a support call, not a feature.
    await refused(setOrganisationStatus(actor, own, 'suspended'), 'validation_failed');
  });

  it('restores again', async () => {
    const actor = await actorFor(ADMIN);
    const { tenant } = await createOrganisation(actor, {
      name: 'Northern Grid',
      adminEmail: 'lead@mahajan.com',
    });

    await setOrganisationStatus(actor, tenant.id, 'suspended');
    await setOrganisationStatus(actor, tenant.id, 'active');
    expect((await getStore()).tenants.find((c) => c.id === tenant.id)?.status).toBe('active');
  });
});

describe('the platform view', () => {
  it('counts projects, modules and people per organisation without exposing their contents', async () => {
    const store = await getStore();
    const view = buildPlatformView(store, await actorFor(ADMIN));
    const flowOne = view.organisations.find((organisation) => organisation.slug === 'flow-one')!;

    expect(flowOne.project_count).toBe(3);
    expect(flowOne.configured_project_count).toBe(1);
    expect(flowOne.module_count).toBe(18);
    expect(flowOne.admins.map((admin) => admin.email)).toContain('parmahaj@mahajan.com');

    // Counts and names only. No cell, defect, audit entry or module name anywhere in it.
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('128_TGRP_CONFIGURATION_IN_CFX');
    expect(serialised).not.toContain('CRAUT-');
  });

  it('names an organisation that has nobody who can administer it', async () => {
    const actor = await actorFor(ADMIN);
    const { tenant } = await createOrganisation(actor, {
      name: 'Orphan Works',
      adminEmail: 'lead@mahajan.com',
    });

    await mutate((store) => {
      store.memberships = store.memberships.filter((row) => row.tenant_id !== tenant.id);
    });

    const view = buildPlatformView(await getStore(), actor);
    const orphan = view.organisations.find((organisation) => organisation.id === tenant.id)!;
    expect(orphan.admins).toEqual([]);
  });
});
