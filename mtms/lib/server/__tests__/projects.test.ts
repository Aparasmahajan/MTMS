import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth';
import {
  addColumn,
  addProjectMember,
  buildSnapshot,
  createProject,
  removeProjectMember,
  setMemberRole,
} from '../service';
import { getStore, mutate } from '../store';
import {
  ADMIN,
  DEV,
  DEVOPS,
  VIEWER,
  actorFor,
  projectId,
  refused,
  roleId,
  useSeededStore,
} from './harness';

/**
 * Part 4.1 and 4.2 — standing up a second project, and who can open it.
 *
 * Membership tests run against the seeded CMDB project, which nobody has project-scoped
 * access to: in CR_AUTOMATION every seeded user is already a member, so there would be
 * nobody left to add.
 */

let admin: Actor;
let dev: Actor;
let devops: Actor;
let viewer: Actor;
let project: string;
let other: string;

beforeEach(async () => {
  await useSeededStore();
  admin = await actorFor(ADMIN);
  dev = await actorFor(DEV);
  devops = await actorFor(DEVOPS);
  viewer = await actorFor(VIEWER);
  project = await projectId();
  other = await projectId('CMDB');
});

async function snapshotOf(actor: Actor, id: string) {
  return buildSnapshot(await getStore(), actor, id);
}

// ---------------------------------------------------------------------------
// 4.1 Creating a project
// ---------------------------------------------------------------------------

describe('creating a project', () => {
  it('starts it empty, so the team defines its own process', async () => {
    const { projectId: created } = await createProject(admin, project, {
      key: 'RADIO_ROLLOUT',
      name: 'Radio rollout',
      description: 'Second team',
    });

    const snapshot = await snapshotOf(admin, created);
    expect(snapshot.project.key).toBe('RADIO_ROLLOUT');
    expect(snapshot.config.columns).toHaveLength(0);
    expect(snapshot.config.node_types).toHaveLength(0);
    expect(snapshot.config.stages).toHaveLength(0);
    expect(snapshot.modules).toHaveLength(0);

    // It does not inherit CR_AUTOMATION's fourteen columns — that is the whole point.
    const original = await snapshotOf(admin, project);
    expect(original.config.columns).toHaveLength(14);
  });

  it('appears in the switcher as not configured, then configured once it has a column', async () => {
    const { projectId: created } = await createProject(admin, project, {
      key: 'RADIO_ROLLOUT',
      name: '',
      description: '',
    });

    let listed = (await snapshotOf(admin, project)).projects.find((entry) => entry.id === created);
    expect(listed?.configured).toBe(false);
    expect(listed?.module_count).toBe(0);

    await addColumn(admin, created, 'Smoke test');

    listed = (await snapshotOf(admin, project)).projects.find((entry) => entry.id === created);
    expect(listed?.configured).toBe(true);
  });

  it('falls back to the key when no name is given', async () => {
    const { projectId: created } = await createProject(admin, project, {
      key: 'RADIO_ROLLOUT',
      name: '',
      description: '',
    });
    expect((await snapshotOf(admin, created)).project.name).toBe('RADIO_ROLLOUT');
  });

  it('uppercases the key and refuses one that is not a key', async () => {
    const { projectId: created } = await createProject(admin, project, {
      key: 'radio_rollout',
      name: '',
      description: '',
    });
    expect((await snapshotOf(admin, created)).project.key).toBe('RADIO_ROLLOUT');

    for (const bad of ['9LIVES', 'has spaces', 'has-hyphens', 'X']) {
      await refused(
        createProject(admin, project, { key: bad, name: '', description: '' }),
        'validation_failed',
      );
    }
  });

  it('refuses a key already used in the organisation', async () => {
    const error = await refused(
      createProject(admin, project, { key: 'CMDB', name: '', description: '' }),
      'conflict',
    );
    expect(error.message).toContain('already exists');
  });

  it('refuses anyone without project.create — including a sub-admin', async () => {
    for (const actor of [viewer, dev, devops]) {
      await refused(
        createProject(actor, project, { key: 'NOPE_PROJECT', name: '', description: '' }),
        'forbidden',
      );
    }

    const subadmin = await actorFor('a.iyer@nokia.com');
    await refused(
      createProject(subadmin, project, { key: 'NOPE_PROJECT', name: '', description: '' }),
      'forbidden',
    );
  });
});

// ---------------------------------------------------------------------------
// 4.2 Project members
// ---------------------------------------------------------------------------

describe('project members', () => {
  it('lists organisation-wide access as present but not editable here', async () => {
    const members = (await snapshotOf(admin, other)).members;
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((member) => member.org_wide)).toBe(true);
    expect(members.every((member) => !member.editable)).toBe(true);
    expect(members[0]?.locked_reason).toBe(
      'Organisation-wide access — change it on the Access screen',
    );
  });

  it('adds someone to the project', async () => {
    await addProjectMember(admin, other, { userId: dev.userId, roleId: await roleId('dev') });

    const member = (await snapshotOf(admin, other)).members.find(
      (candidate) => candidate.user_id === dev.userId,
    );
    expect(member?.role_name).toBe('Developer');
    expect(member?.org_wide).toBe(false);
    expect(member?.editable).toBe(true);

    // And the access is real: they can now open the project.
    expect((await snapshotOf(dev, other)).project.key).toBe('CMDB');
  });

  it('refuses to add someone who can already reach the project', async () => {
    await addProjectMember(admin, other, { userId: dev.userId, roleId: await roleId('dev') });
    const error = await refused(
      addProjectMember(admin, other, { userId: dev.userId, roleId: await roleId('qa') }),
      'conflict',
    );
    expect(error.message).toContain('already has access');

    // Including via an organisation-wide membership.
    await refused(
      addProjectMember(admin, other, { userId: admin.userId, roleId: await roleId('viewer') }),
      'conflict',
    );
  });

  it('changes a role and removes access', async () => {
    await addProjectMember(admin, other, { userId: dev.userId, roleId: await roleId('dev') });
    const membershipId = (await snapshotOf(admin, other)).members.find(
      (candidate) => candidate.user_id === dev.userId,
    )!.membership_id;

    await setMemberRole(admin, other, membershipId, await roleId('qa'));
    expect(
      (await snapshotOf(admin, other)).members.find((c) => c.user_id === dev.userId)?.role_name,
    ).toBe('QA');

    await removeProjectMember(admin, other, membershipId);
    expect(
      (await snapshotOf(admin, other)).members.some((c) => c.user_id === dev.userId),
    ).toBe(false);
    // And the access is gone: the project no longer opens for them.
    await refused(Promise.resolve().then(() => snapshotOf(dev, other)), 'forbidden');
  });

  it('refuses to give out a role holding more than the actor holds', async () => {
    await mutate((store) => {
      const role = store.roles.find((candidate) => candidate.key === 'admin')!;
      role.permissions = role.permissions.filter((key) => key !== 'fni.signoff');
    });

    const error = await refused(
      addProjectMember(admin, other, { userId: dev.userId, roleId: await roleId('release') }),
      'forbidden',
    );
    expect(error.message).toContain('fni.signoff');
  });

  it('refuses to touch an organisation-wide membership from a project screen', async () => {
    const orgWide = (await snapshotOf(admin, other)).members[0]!;
    const error = await refused(
      setMemberRole(admin, other, orgWide.membership_id, await roleId('viewer')),
      'bad_request',
    );
    expect(error.message).toContain('organisation-wide');
    await refused(removeProjectMember(admin, other, orgWide.membership_id), 'bad_request');
  });

  it('refuses to let someone change or remove their own access', async () => {
    // Give the Developer role the permission, so a project-scoped member can try it.
    await mutate((store) => {
      const role = store.roles.find((candidate) => candidate.key === 'dev')!;
      role.permissions.push('project.members.manage');
    });

    const own = (await snapshotOf(dev, project)).members.find(
      (candidate) => candidate.user_id === dev.userId,
    )!;
    expect(own.editable).toBe(false);
    expect(own.locked_reason).toBe('You cannot change your own access');

    await refused(
      setMemberRole(dev, project, own.membership_id, await roleId('qa')),
      'bad_request',
    );
    await refused(removeProjectMember(dev, project, own.membership_id), 'bad_request');
  });

  it('refuses anyone without project.members.manage', async () => {
    await refused(
      addProjectMember(viewer, other, { userId: dev.userId, roleId: await roleId('dev') }),
      'forbidden',
    );
    await refused(
      addProjectMember(devops, other, { userId: dev.userId, roleId: await roleId('dev') }),
      'forbidden',
    );
  });

  it('refuses a user or a role that does not exist', async () => {
    await refused(
      addProjectMember(admin, other, {
        userId: '00000000-0000-4000-8000-000000000000',
        roleId: await roleId('dev'),
      }),
      'not_found',
    );
    await refused(
      addProjectMember(admin, other, {
        userId: dev.userId,
        roleId: '00000000-0000-4000-8000-000000000000',
      }),
      'not_found',
    );
  });
});
