import { beforeEach, describe, expect, it } from 'vitest';
import { BLANK, toneOf } from '../../shared/vocabulary';
import { columnDisplayLabel } from '../../shared/views';
import type { Actor } from '../auth';
import {
  addColumn,
  advanceCell,
  buildSnapshot,
  cloneFromLibrary,
  confirmLoadedInProd,
  createDefect,
  inviteUser,
  removeColumn,
  setColumnCounts,
  signOffFni,
  toggleGrant,
} from '../service';
import { getStore, mutate } from '../store';
import {
  ADMIN,
  DEVOPS,
  MODULE_FULL,
  MODULE_FULL_WITH_SUBS,
  MODULE_NOT_STARTED,
  MODULE_PARTIAL_WITH_SUBS,
  VIEWER,
  actorFor,
  cellsOf,
  libraryId,
  moduleId,
  projectId,
  refused,
  roleId,
  useSeededStore,
} from './harness';

/**
 * The rules the server refuses to break, whatever the client sends. Everything here
 * goes through the service directly: the route handlers only turn a `ServiceError`
 * code into an HTTP status, so testing them again would test Next.js, not the rules.
 */

let admin: Actor;
let devops: Actor;
let viewer: Actor;
let project: string;

beforeEach(async () => {
  await useSeededStore();
  admin = await actorFor(ADMIN);
  devops = await actorFor(DEVOPS);
  viewer = await actorFor(VIEWER);
  project = await projectId();
});

async function snapshotFor(actor: Actor) {
  return buildSnapshot(await getStore(), actor, project);
}

async function moduleView(actor: Actor, name: string) {
  const snapshot = await snapshotFor(actor);
  const view = snapshot.modules.find((module) => module.name === name);
  if (!view) throw new Error(`No module ${name} in the projection`);
  return view;
}

// ---------------------------------------------------------------------------
// The FNI gate
// ---------------------------------------------------------------------------

describe('the FNI gate', () => {
  it('refuses to close a module below 100%, and says why', async () => {
    const module = await moduleId(MODULE_NOT_STARTED);
    const error = await refused(signOffFni(admin, project, module, true), 'bad_request');

    expect(error.message).toBe(
      'Blocked — DevOps has not confirmed every deliverable loaded in prod; ' +
        'FNI final submission is not complete',
    );
  });

  it('refuses at 100% when the FNI column itself is not done', async () => {
    // With FNI not counting toward readiness, a module can reach 100% with its FNI
    // cell still pending. The gate has to catch that on its own.
    const module = await moduleId(MODULE_FULL);
    await setColumnCounts(admin, project, 'fni', false);
    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: null,
      columnKey: 'fni',
      status: 'pending',
    });

    expect((await moduleView(admin, MODULE_FULL)).readiness).toBe(100);

    const error = await refused(signOffFni(admin, project, module, true), 'bad_request');
    expect(error.message).toBe('Blocked — FNI final submission is not complete');
  });

  it('closes the module when readiness is 100% and FNI is done', async () => {
    const module = await moduleId(MODULE_FULL);
    expect((await moduleView(admin, MODULE_FULL)).readiness).toBe(100);

    await signOffFni(admin, project, module, true);

    const view = await moduleView(admin, MODULE_FULL);
    expect(view.closed).toBe(true);
    expect(view.closed_by).toBe('P. Mahajan');
  });

  it('recomputes readiness from the store rather than trusting the caller', async () => {
    // Break one deliverable on an otherwise complete module and the gate must shut,
    // even though nothing in the request mentions readiness.
    const module = await moduleId(MODULE_FULL);
    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: null,
      columnKey: 'bst',
      status: 'notloaded',
    });

    const error = await refused(signOffFni(admin, project, module, true), 'bad_request');
    expect(error.message).toContain('DevOps has not confirmed every deliverable loaded in prod');
  });
});

// ---------------------------------------------------------------------------
// The roll-up guard
// ---------------------------------------------------------------------------

describe('the roll-up guard', () => {
  it('refuses to write a module cell that has subactivities under it', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    const error = await refused(
      advanceCell(admin, project, {
        moduleId: module,
        subactivityId: null,
        columnKey: 'filecr_prod',
      }),
      'bad_request',
    );

    expect(error.message).toBe(
      'This module has subactivities, so its row is a roll-up. Change the subactivity instead.',
    );
  });

  it('derives the module cell from the subactivity that was written', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    const before = await moduleView(admin, MODULE_FULL_WITH_SUBS);
    const first = before.subactivities[0]!;
    expect(before.cells.find((cell) => cell.column_key === 'filecr_prod')?.status).toBe('loaded');

    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: first.id,
      columnKey: 'filecr_prod',
      status: 'notloaded',
    });

    const after = await moduleView(admin, MODULE_FULL_WITH_SUBS);
    const cell = after.cells.find((candidate) => candidate.column_key === 'filecr_prod');
    expect(cell?.status).toBe('notloaded');
    expect(cell?.rolled_up).toBe(true);
    expect(cell?.subactivity_count).toBe(2);
  });

  it('applies the precedence rule when subactivities disagree', async () => {
    // The seeded subactivities all carry the same row, so nothing in the fixture forces
    // the projection to resolve a blank against a not-done. Build that case: one
    // subactivity done, one not done, one never filled in. The blank has to win, or a
    // module with a forgotten cell would read as merely behind rather than unrecorded.
    const module = await moduleId(MODULE_PARTIAL_WITH_SUBS);
    const subs = (await moduleView(admin, MODULE_PARTIAL_WITH_SUBS)).subactivities;
    expect(subs).toHaveLength(3);
    expect(
      subs.every((sub) => sub.cells.find((cell) => cell.column_key === 'filecr_prod')?.status === BLANK),
    ).toBe(true);

    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: subs[0]!.id,
      columnKey: 'filecr_prod',
      status: 'loaded',
    });
    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: subs[1]!.id,
      columnKey: 'filecr_prod',
      status: 'notloaded',
    });

    const cell = (await moduleView(admin, MODULE_PARTIAL_WITH_SUBS)).cells.find(
      (candidate) => candidate.column_key === 'filecr_prod',
    );
    expect(cell?.status).toBe(BLANK);

    // Fill the last one in and the not-done takes over — still not the done status.
    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: subs[2]!.id,
      columnKey: 'filecr_prod',
      status: 'loaded',
    });
    const after = (await moduleView(admin, MODULE_PARTIAL_WITH_SUBS)).cells.find(
      (candidate) => candidate.column_key === 'filecr_prod',
    );
    expect(after?.status).toBe('notloaded');
  });

  it('refuses a subactivity that is not on the module', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    await refused(
      advanceCell(admin, project, {
        moduleId: module,
        subactivityId: 'not-a-subactivity',
        columnKey: 'filecr_prod',
      }),
      'not_found',
    );
  });

  it('refuses a status the column does not allow', async () => {
    const module = await moduleId(MODULE_FULL);
    const error = await refused(
      advanceCell(admin, project, {
        moduleId: module,
        subactivityId: null,
        columnKey: 'fni',
        status: 'prod',
      }),
      'validation_failed',
    );

    expect(error.message).toContain('FNI cannot take that status');
    expect(error.message).toContain('It allows: Pending, Completed.');
  });
});

// ---------------------------------------------------------------------------
// A closed module
// ---------------------------------------------------------------------------

describe('a closed module', () => {
  beforeEach(async () => {
    await signOffFni(admin, project, await moduleId(MODULE_FULL), true);
  });

  it('refuses a deliverable change', async () => {
    const module = await moduleId(MODULE_FULL);
    const error = await refused(
      advanceCell(admin, project, { moduleId: module, subactivityId: null, columnKey: 'bst' }),
      'bad_request',
    );
    expect(error.message).toBe('This module is closed. Reopen it before changing a deliverable.');
  });

  it('refuses a prod confirmation', async () => {
    const module = await moduleId(MODULE_FULL);
    await refused(confirmLoadedInProd(admin, project, module), 'bad_request');
  });

  it('allows both again once it is reopened', async () => {
    const module = await moduleId(MODULE_FULL);
    await signOffFni(admin, project, module, false);

    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: null,
      columnKey: 'bst',
      status: 'notloaded',
    });
    await confirmLoadedInProd(admin, project, module);

    const view = await moduleView(admin, MODULE_FULL);
    expect(view.closed).toBe(false);
    expect(view.readiness).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('permissions', () => {
  it('lets a viewer read the project and nothing else', async () => {
    const snapshot = await snapshotFor(viewer);
    expect(snapshot.me.permissions).toEqual(['project.view']);
    expect(snapshot.modules).toHaveLength(18);
  });

  it('refuses a viewer every mutation', async () => {
    const module = await moduleId(MODULE_FULL);
    const entry = await libraryId(MODULE_PARTIAL_WITH_SUBS);

    await refused(
      advanceCell(viewer, project, { moduleId: module, subactivityId: null, columnKey: 'bst' }),
      'forbidden',
    );
    await refused(signOffFni(viewer, project, module, true), 'forbidden');
    await refused(confirmLoadedInProd(viewer, project, module), 'forbidden');
    await refused(
      createDefect(viewer, project, {
        moduleId: module,
        phase: 'Staging test',
        ticketKey: 'CRAUT-1',
        childReqId: '',
        severity: 'Low',
        description: 'x',
      }),
      'forbidden',
    );
    await refused(addColumn(viewer, project, 'Something'), 'forbidden');
    await refused(cloneFromLibrary(viewer, project, entry), 'forbidden');
    await refused(
      inviteUser(viewer, project, {
        email: 'new@mahajan.com',
        displayName: 'New',
        roleId: await roleId('viewer'),
        scopeProjectId: project,
      }),
      'forbidden',
    );
  });

  it('names the missing permission in the refusal', async () => {
    const module = await moduleId(MODULE_FULL);
    const error = await refused(
      advanceCell(viewer, project, { moduleId: module, subactivityId: null, columnKey: 'bst' }),
      'forbidden',
    );
    expect(error.message).toContain('deliverable.update');
  });

  it('lets DevOps confirm prod but not sign off FNI', async () => {
    const module = await moduleId(MODULE_NOT_STARTED);

    const { changed } = await confirmLoadedInProd(devops, project, module);
    expect(changed).toBeGreaterThan(0);
    expect((await moduleView(devops, MODULE_NOT_STARTED)).readiness).toBe(100);

    await refused(signOffFni(devops, project, module, true), 'forbidden');
  });

  it('stamps a prod confirmation into the audit trail', async () => {
    const module = await moduleId(MODULE_NOT_STARTED);
    await confirmLoadedInProd(devops, project, module);

    const snapshot = await snapshotFor(admin);
    const entries = snapshot.audit.filter((entry) => entry.module_id === module);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.who === 'V. Rao')).toBe(true);
    expect(entries[0]?.what).toContain('prod confirmation');
  });
});

// ---------------------------------------------------------------------------
// Handing out access
// ---------------------------------------------------------------------------

describe('granting permissions', () => {
  it('grants and revokes on a role', async () => {
    const viewerRole = await roleId('viewer');
    await toggleGrant(admin, project, viewerRole, 'defect.create', true);

    let snapshot = await snapshotFor(admin);
    expect(snapshot.roles.find((role) => role.key === 'viewer')?.permissions).toContain(
      'defect.create',
    );

    await toggleGrant(admin, project, viewerRole, 'defect.create', false);
    snapshot = await snapshotFor(admin);
    expect(snapshot.roles.find((role) => role.key === 'viewer')?.permissions).not.toContain(
      'defect.create',
    );
  });

  it('refuses to grant a permission the actor does not hold', async () => {
    // Take FNI sign-off away from the admin's own role, then have them try to hand it
    // to somebody else. Nobody can give away more than they hold.
    await mutate((store) => {
      const role = store.roles.find((candidate) => candidate.key === 'admin')!;
      role.permissions = role.permissions.filter((key) => key !== 'fni.signoff');
    });

    const error = await refused(
      toggleGrant(admin, project, await roleId('viewer'), 'fni.signoff', true),
      'forbidden',
    );
    expect(error.message).toContain('you do not hold it yourself');
  });

  it('still allows revoking a permission the actor does not hold', async () => {
    await mutate((store) => {
      const role = store.roles.find((candidate) => candidate.key === 'admin')!;
      role.permissions = role.permissions.filter((key) => key !== 'fni.signoff');
    });

    await toggleGrant(admin, project, await roleId('release'), 'fni.signoff', false);
    const snapshot = await snapshotFor(admin);
    expect(snapshot.roles.find((role) => role.key === 'release')?.permissions).not.toContain(
      'fni.signoff',
    );
  });

  it('rejects something that is not a permission key', async () => {
    await refused(
      toggleGrant(admin, project, await roleId('viewer'), 'project.destroy', true),
      'validation_failed',
    );
  });
});

describe('inviting a user', () => {
  it('creates the account, the membership and the invitation', async () => {
    const result = await inviteUser(admin, project, {
      email: 'N.Desai2@mahajan.com',
      displayName: 'N. Desai',
      roleId: await roleId('qa'),
      scopeProjectId: project,
    });

    expect(result.email).toBe('n.desai2@mahajan.com');
    expect(result.inviteToken).toBeTruthy();

    const store = await getStore();
    const user = store.users.find((candidate) => candidate.email === 'n.desai2@mahajan.com');
    expect(user?.status).toBe('invited');
    expect(user?.password_hash).toBe('');
    expect(user?.invite_token_hash).toBeTruthy();
    expect(
      store.memberships.some((membership) => membership.user_id === user?.id),
    ).toBe(true);

    const snapshot = await snapshotFor(admin);
    expect(snapshot.invitations.some((invite) => invite.email === 'n.desai2@mahajan.com')).toBe(true);
  });

  it('refuses a role holding permissions the actor lacks', async () => {
    await mutate((store) => {
      const role = store.roles.find((candidate) => candidate.key === 'admin')!;
      role.permissions = role.permissions.filter((key) => key !== 'fni.signoff');
    });

    const error = await refused(
      inviteUser(admin, project, {
        email: 'new@mahajan.com',
        displayName: 'New',
        roleId: await roleId('release'),
        scopeProjectId: project,
      }),
      'forbidden',
    );
    expect(error.message).toContain('fni.signoff');
  });

  it('refuses an email that already has an account', async () => {
    await refused(
      inviteUser(admin, project, {
        email: 'k.menon@mahajan.com',
        displayName: 'K. Menon',
        roleId: await roleId('viewer'),
        scopeProjectId: project,
      }),
      'validation_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('removing a column', () => {
  it('takes the column cells with it, and only in that project', async () => {
    // Give a second project a column of the same key, with a cell filled in, so the
    // deletion has something it could wrongly reach.
    const otherProject = await projectId('CMDB');
    await mutate((store) => {
      store.columns.push({
        id: 'column-cmdb-fni',
        project_id: otherProject,
        key: 'fni',
        label: 'FNI',
        full: 'FNI — final submission',
        allowed: ['pending', 'completed'],
        counts: true,
        order_index: 0,
        environment: null,
        group_key: null,
        group_label: null,
      });
      store.modules.push({
        id: 'module-cmdb',
        project_id: otherProject,
        node_type: 'SBC',
        name: 'A module in the other project',
        library_entry_id: null,
        owner: null,
        fni_target_date: null,
        fni_closed_at: null,
        fni_closed_by: null,
        created_at: new Date().toISOString(),
      });
      store.cells.push({
        module_id: 'module-cmdb',
        subactivity_id: null,
        column_key: 'fni',
        status: 'completed',
        changed_by: null,
        changed_at: null,
      });
    });

    await removeColumn(admin, project, 'fni');

    const store = await getStore();
    const trackedModules = new Set(
      store.modules.filter((module) => module.project_id === project).map((module) => module.id),
    );
    expect(
      store.cells.some((cell) => trackedModules.has(cell.module_id) && cell.column_key === 'fni'),
    ).toBe(false);
    expect(
      store.cells.some((cell) => cell.module_id === 'module-cmdb' && cell.column_key === 'fni'),
    ).toBe(true);

    const snapshot = await snapshotFor(admin);
    expect(snapshot.config.columns).toHaveLength(25);
    expect(snapshot.config.columns.some((column) => column.key === 'fni')).toBe(false);
  });

  it('refuses a column that is not on the project', async () => {
    await refused(removeColumn(admin, project, 'nonsense'), 'not_found');
  });
});

describe('cloning from the library', () => {
  it('leaves the library definition alone and starts every cell blank', async () => {
    const entryId = await libraryId(MODULE_PARTIAL_WITH_SUBS);
    const before = (await getStore()).library.find((entry) => entry.id === entryId)!;
    const definition = [...before.subactivity_names];
    const useCount = before.used_in_projects;

    const { moduleId: cloned, nodeType } = await cloneFromLibrary(admin, project, entryId);

    const store = await getStore();
    const after = store.library.find((entry) => entry.id === entryId)!;
    expect(after.subactivity_names).toEqual(definition);
    expect(after.name).toBe(before.name);
    // The use count is a tally, not part of the definition — it does move.
    expect(after.used_in_projects).toBe(useCount + 1);

    expect(nodeType).toBe('CFX');
    const subs = store.subactivities.filter((sub) => sub.module_id === cloned);
    expect(subs).toHaveLength(3);

    const cells = await cellsOf(cloned);
    expect(cells).toHaveLength(3 * 26);
    expect(cells.every((cell) => cell.status === BLANK)).toBe(true);
  });

  it('adds the node type to the project when it is missing', async () => {
    await mutate((store) => {
      const config = store.project_config.find((entry) => entry.project_id === project)!;
      config.node_types = config.node_types.filter((type) => type !== 'CFX');
    });

    await cloneFromLibrary(admin, project, await libraryId(MODULE_PARTIAL_WITH_SUBS));

    const snapshot = await snapshotFor(admin);
    expect(snapshot.config.node_types).toContain('CFX');
  });

  it('refuses a library entry that does not exist', async () => {
    await refused(cloneFromLibrary(admin, project, 'not-an-entry'), 'not_found');
  });
});

// ---------------------------------------------------------------------------
// Part 2.3 — the seeded projection
// ---------------------------------------------------------------------------

/**
 * Known-good numbers for the seeded sheet, verified by hand against the design
 * prototype's own maths. They are here so that a change to the roll-up rule, to
 * readiness, or to the seed itself fails loudly rather than quietly shifting what the
 * dashboard reports.
 */
describe('the seeded projection', () => {
  it('matches the DevOps sheet it was built from', async () => {
    const snapshot = await snapshotFor(admin);

    expect(snapshot.modules).toHaveLength(18);
    expect(snapshot.config.columns).toHaveLength(26);

    const fullyInProd = snapshot.modules.filter((module) => module.readiness === 100);
    expect(fullyInProd).toHaveLength(3);

    const notStarted = snapshot.modules.filter((module) => module.readiness === 0);
    expect(notStarted).toHaveLength(3);

    const blanks = snapshot.modules.reduce((total, module) => total + module.blank_count, 0);
    expect(blanks).toBe(118);
  });

  it('carries the CFX module at 58% across three subactivities', async () => {
    const view = await moduleView(admin, MODULE_PARTIAL_WITH_SUBS);

    expect(view.readiness).toBe(58);
    expect(view.subactivities).toHaveLength(3);
    expect(view.cells.every((cell) => cell.rolled_up)).toBe(true);
    expect(view.blank_count).toBe(8);
    expect(view.missing).toEqual(['FILECR·PROD', 'CLICR·PROD', 'NEMO', 'FNI', 'ACCESS']);
  });

  it('counts EMAIL and RITM out of readiness but keeps them on the matrix', async () => {
    const snapshot = await snapshotFor(admin);
    const uncounted = snapshot.config.columns.filter((column) => !column.counts);
    expect(uncounted.map((column) => column.key)).toEqual([
      // Every lab and preprod column: a tick there records where a deliverable has
      // been, and readiness has always meant ready in prod.
      'filecr_lab',
      'filecr_preprod',
      'clicr_lab',
      'clicr_preprod',
      'html_lab',
      'html_preprod',
      'json_lab',
      'json_preprod',
      'valid_lab',
      'valid_preprod',
      'exec_lab',
      'exec_preprod',
      'email',
      'ritm',
    ]);

    // Every module carries a cell for them all the same — a column that does not count
    // is still tracked, it just does not gate prod.
    for (const module of snapshot.modules) {
      expect(module.cells).toHaveLength(26);
    }
  });

  it('buckets every module into one of the six configured stages', async () => {
    const snapshot = await snapshotFor(admin);
    expect(snapshot.config.stages).toHaveLength(6);

    for (const module of snapshot.modules) {
      expect(module.stage_index).toBeGreaterThanOrEqual(0);
      expect(module.stage_index).toBeLessThan(6);
      expect(module.stage_index === 5).toBe(module.readiness === 100);
    }
  });

  it('lists the deliverables a module is missing, and none that it holds', async () => {
    const snapshot = await snapshotFor(admin);
    const counted = snapshot.config.columns.filter((column) => column.counts);

    for (const module of snapshot.modules) {
      for (const column of counted) {
        const status = module.cells.find((cell) => cell.column_key === column.key)?.status ?? BLANK;
        expect(module.missing.includes(columnDisplayLabel(column))).toBe(toneOf(status) !== 'done');
      }
    }
  });
});
