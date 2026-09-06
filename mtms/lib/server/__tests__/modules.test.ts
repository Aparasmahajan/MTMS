import { beforeEach, describe, expect, it } from 'vitest';
import { BLANK } from '../../shared/vocabulary';
import type { Actor } from '../auth';
import {
  addSubactivity,
  advanceCell,
  assignDefect,
  buildSnapshot,
  createModule,
  removeSubactivity,
  renameSubactivity,
  signOffFni,
} from '../service';
import { getStore, mutate } from '../store';
import {
  ADMIN,
  DEV,
  DEVOPS,
  MODULE_FULL,
  MODULE_FULL_WITH_SUBS,
  QA,
  VIEWER,
  actorFor,
  cellsOf,
  moduleId,
  projectId,
  refused,
  useSeededStore,
} from './harness';

/**
 * Part 3.3, 3.4 and 3.5 — creating a module, editing its subactivities, and assigning
 * a defect.
 *
 * The subactivity tests carry the weight here. Adding the first subactivity turns a
 * module's row from stored into derived, and removing the last one turns it back; both
 * directions have to preserve the work already recorded rather than resetting it.
 */

let admin: Actor;
let dev: Actor;
let devops: Actor;
let qa: Actor;
let viewer: Actor;
let project: string;

beforeEach(async () => {
  await useSeededStore();
  admin = await actorFor(ADMIN);
  dev = await actorFor(DEV);
  devops = await actorFor(DEVOPS);
  qa = await actorFor(QA);
  viewer = await actorFor(VIEWER);
  project = await projectId();
});

async function snapshot() {
  return buildSnapshot(await getStore(), admin, project);
}

async function view(id: string) {
  const found = (await snapshot()).modules.find((module) => module.id === id);
  if (!found) throw new Error('That module is not in the projection');
  return found;
}

// ---------------------------------------------------------------------------
// 3.3 Creating a module
// ---------------------------------------------------------------------------

describe('creating a module directly', () => {
  it('creates it with every cell blank', async () => {
    const { moduleId: created } = await createModule(admin, project, {
      nodeType: 'SBC',
      name: '99_A_BRAND_NEW_ACTIVITY',
      addToLibrary: false,
    });

    const module = await view(created);
    expect(module.node_type).toBe('SBC');
    expect(module.readiness).toBe(0);
    expect(module.subactivities).toHaveLength(0);
    expect(module.blank_count).toBe(14);

    const cells = await cellsOf(created);
    expect(cells).toHaveLength(14);
    expect(cells.every((cell) => cell.status === BLANK)).toBe(true);
    expect((await snapshot()).modules).toHaveLength(19);
  });

  it('refuses the same node type and name twice — that pair is the identity', async () => {
    await createModule(admin, project, {
      nodeType: 'SBC',
      name: 'A_REPEATED_ACTIVITY',
      addToLibrary: false,
    });

    const error = await refused(
      createModule(admin, project, {
        nodeType: 'SBC',
        name: 'A_REPEATED_ACTIVITY',
        addToLibrary: false,
      }),
      'conflict',
    );
    expect(error.message).toContain('already tracked on this project');
  });

  it('allows the same activity name under a different node type', async () => {
    await createModule(admin, project, {
      nodeType: 'SBC',
      name: 'SHARED_ACTIVITY_NAME',
      addToLibrary: false,
    });
    await createModule(admin, project, {
      nodeType: 'CFX',
      name: 'SHARED_ACTIVITY_NAME',
      addToLibrary: false,
    });

    const matching = (await snapshot()).modules.filter(
      (module) => module.name === 'SHARED_ACTIVITY_NAME',
    );
    expect(matching.map((module) => module.node_type).sort()).toEqual(['CFX', 'SBC']);
  });

  it('refuses a node type the project has not configured', async () => {
    const error = await refused(
      createModule(admin, project, { nodeType: 'HSS', name: 'X', addToLibrary: false }),
      'validation_failed',
    );
    expect(error.message).toContain('not a node type on this project');
  });

  it('refuses an empty name', async () => {
    await refused(
      createModule(admin, project, { nodeType: 'SBC', name: '   ', addToLibrary: false }),
      'validation_failed',
    );
  });

  it('leaves the library alone unless asked', async () => {
    const before = (await snapshot()).library.length;
    await createModule(admin, project, {
      nodeType: 'SBC',
      name: 'NOT_FOR_THE_LIBRARY',
      addToLibrary: false,
    });
    expect((await snapshot()).library).toHaveLength(before);
  });

  it('catalogues it when asked', async () => {
    const { moduleId: created } = await createModule(admin, project, {
      nodeType: 'SBC',
      name: 'WORTH_CLONING',
      addToLibrary: true,
    });

    const entry = (await snapshot()).library.find((candidate) => candidate.name === 'WORTH_CLONING');
    expect(entry).toBeDefined();
    expect(entry?.node_type).toBe('SBC');
    expect(entry?.used_in_projects).toBe(1);
    expect(entry?.in_this_project).toBe(true);

    const store = await getStore();
    const module = store.modules.find((candidate) => candidate.id === created);
    expect(module?.library_entry_id).toBe(
      store.library.find((candidate) => candidate.name === 'WORTH_CLONING')?.id,
    );
  });

  it('reuses an existing library entry rather than duplicating it', async () => {
    const name = '88_TLS_CERT_RENEWAL_IN_SBC'; // already in the seeded library, under SBC
    const before = (await snapshot()).library;
    const entryBefore = before.find((candidate) => candidate.name === name)!;

    await createModule(admin, project, { nodeType: 'SBC', name, addToLibrary: true });

    const after = (await snapshot()).library;
    expect(after).toHaveLength(before.length);
    const entryAfter = after.find((candidate) => candidate.name === name)!;
    expect(entryAfter.used_in_projects).toBe(entryBefore.used_in_projects + 1);
  });

  it('refuses anyone without module.create', async () => {
    for (const actor of [viewer, dev, devops]) {
      await refused(
        createModule(actor, project, { nodeType: 'SBC', name: 'NOPE', addToLibrary: false }),
        'forbidden',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3.4 Subactivities
// ---------------------------------------------------------------------------

describe('adding a subactivity', () => {
  it('carries the module’s own row onto the first one instead of stranding it', async () => {
    const module = await moduleId(MODULE_FULL);
    const before = await view(module);
    expect(before.readiness).toBe(100);
    expect(before.cells.every((cell) => !cell.rolled_up)).toBe(true);

    const { subactivityId } = await addSubactivity(admin, project, module, 'Everything so far');

    const after = await view(module);
    expect(after.readiness).toBe(100);
    expect(after.cells.every((cell) => cell.rolled_up)).toBe(true);
    expect(after.subactivities).toHaveLength(1);
    expect(after.subactivities[0]!.readiness).toBe(100);

    // The cells moved rather than being copied: nothing is left on the module's own row.
    const cells = await cellsOf(module);
    expect(cells.filter((cell) => cell.subactivity_id === null)).toHaveLength(0);
    expect(cells.filter((cell) => cell.subactivity_id === subactivityId)).toHaveLength(14);
  });

  it('starts a second subactivity blank, which pulls the roll-up back to blank', async () => {
    const module = await moduleId(MODULE_FULL);
    await addSubactivity(admin, project, module, 'Everything so far');
    await addSubactivity(admin, project, module, 'Something new');

    const after = await view(module);
    expect(after.subactivities).toHaveLength(2);
    expect(after.subactivities[1]!.readiness).toBe(0);
    // A blank beats a done, so the module reads as unrecorded rather than complete.
    expect(after.cells.every((cell) => cell.status === BLANK)).toBe(true);
    expect(after.readiness).toBe(0);
  });

  it('refuses a duplicate name on the same module', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    await refused(
      addSubactivity(admin, project, module, 'Load announcement set'),
      'conflict',
    );
  });

  it('refuses an empty name', async () => {
    await refused(addSubactivity(admin, project, await moduleId(MODULE_FULL), '  '), 'validation_failed');
  });

  it('refuses a viewer', async () => {
    await refused(addSubactivity(viewer, project, await moduleId(MODULE_FULL), 'X'), 'forbidden');
  });

  it('refuses a closed module', async () => {
    const module = await moduleId(MODULE_FULL);
    await signOffFni(admin, project, module, true);

    const error = await refused(addSubactivity(admin, project, module, 'X'), 'bad_request');
    expect(error.message).toBe(
      'This module is closed. Reopen it before changing its subactivities.',
    );
  });
});

describe('renaming a subactivity', () => {
  it('renames it', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    const target = (await view(module)).subactivities[0]!;

    await renameSubactivity(admin, project, module, target.id, 'Load the announcement set');

    expect((await view(module)).subactivities[0]!.name).toBe('Load the announcement set');
  });

  it('is allowed on a closed module, because it changes no status', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    const target = (await view(module)).subactivities[0]!;
    await signOffFni(admin, project, module, true);

    await renameSubactivity(admin, project, module, target.id, 'Renamed after closing');
    expect((await view(module)).subactivities[0]!.name).toBe('Renamed after closing');
  });

  it('refuses a subactivity that is not on the module', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    await refused(renameSubactivity(admin, project, module, 'nope', 'X'), 'not_found');
  });

  it('refuses a viewer', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    const target = (await view(module)).subactivities[0]!;
    await refused(renameSubactivity(viewer, project, module, target.id, 'X'), 'forbidden');
  });
});

describe('removing a subactivity', () => {
  it('takes its cells with it and leaves the others alone', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    const before = await view(module);
    expect(before.subactivities).toHaveLength(2);
    const first = before.subactivities[0]!;
    const second = before.subactivities[1]!;

    await removeSubactivity(admin, project, module, first.id);

    const after = await view(module);
    expect(after.subactivities).toHaveLength(1);
    expect(after.subactivities[0]!.id).toBe(second.id);
    expect(after.cells.every((cell) => cell.rolled_up)).toBe(true);

    const cells = await cellsOf(module);
    expect(cells.some((cell) => cell.subactivity_id === first.id)).toBe(false);
    // The survivor is renumbered so the order stays dense.
    const store = await getStore();
    expect(store.subactivities.find((sub) => sub.id === second.id)?.order_index).toBe(0);
  });

  it('hands the module its row back when the last one goes, keeping what it showed', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    const before = await view(module);
    const readinessBefore = before.readiness;
    const statusesBefore = before.cells.map((cell) => `${cell.column_key}:${cell.status}`);

    for (const subactivity of before.subactivities) {
      await removeSubactivity(admin, project, module, subactivity.id);
    }

    const after = await view(module);
    expect(after.subactivities).toHaveLength(0);
    expect(after.cells.every((cell) => !cell.rolled_up)).toBe(true);
    expect(after.readiness).toBe(readinessBefore);
    expect(after.cells.map((cell) => `${cell.column_key}:${cell.status}`)).toEqual(statusesBefore);

    // And the row is editable again.
    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: null,
      columnKey: 'bst',
      status: 'notloaded',
    });
    expect(
      (await view(module)).cells.find((cell) => cell.column_key === 'bst')?.status,
    ).toBe('notloaded');
  });

  it('materialises the roll-up, not the removed subactivity’s own row', async () => {
    // Two subactivities disagreeing: one done, one not. The roll-up is the not-done, and
    // that is what the module's row must inherit when the disagreement is removed.
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    const subs = (await view(module)).subactivities;
    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: subs[1]!.id,
      columnKey: 'bst',
      status: 'notloaded',
    });
    expect((await view(module)).cells.find((cell) => cell.column_key === 'bst')?.status).toBe(
      'notloaded',
    );

    await removeSubactivity(admin, project, module, subs[0]!.id);
    await removeSubactivity(admin, project, module, subs[1]!.id);

    expect((await view(module)).cells.find((cell) => cell.column_key === 'bst')?.status).toBe(
      'notloaded',
    );
  });

  it('refuses a closed module', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    const target = (await view(module)).subactivities[0]!;
    await mutate((store) => {
      store.modules.find((candidate) => candidate.id === module)!.fni_closed_at = new Date().toISOString();
    });

    await refused(removeSubactivity(admin, project, module, target.id), 'bad_request');
  });

  it('refuses a viewer', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    const target = (await view(module)).subactivities[0]!;
    await refused(removeSubactivity(viewer, project, module, target.id), 'forbidden');
  });
});

// ---------------------------------------------------------------------------
// 3.5 Defect assignment
// ---------------------------------------------------------------------------

describe('assigning a defect', () => {
  async function firstDefectId(): Promise<string> {
    const defect = (await snapshot()).defects[0];
    if (!defect) throw new Error('No seeded defects');
    return defect.id;
  }

  it('assigns to one of the project’s configured owners', async () => {
    const defect = await firstDefectId();
    await assignDefect(qa, project, defect, 'R. Kaur');

    expect((await snapshot()).defects.find((entry) => entry.id === defect)?.assignee).toBe('R. Kaur');
  });

  it('unassigns with null', async () => {
    const defect = await firstDefectId();
    await assignDefect(qa, project, defect, 'R. Kaur');
    await assignDefect(qa, project, defect, null);

    expect((await snapshot()).defects.find((entry) => entry.id === defect)?.assignee).toBeNull();
  });

  it('refuses someone who is not an owner on this project', async () => {
    const error = await refused(
      assignDefect(qa, project, await firstDefectId(), 'Someone Else'),
      'validation_failed',
    );
    expect(error.message).toContain('not an owner on this project');
  });

  it('refuses a defect that does not exist', async () => {
    await refused(assignDefect(qa, project, 'not-a-defect', 'R. Kaur'), 'not_found');
  });

  it('is granted to QA but not to DevOps or a viewer', async () => {
    const defect = await firstDefectId();
    await assignDefect(qa, project, defect, 'A. Iyer');
    await refused(assignDefect(devops, project, defect, 'A. Iyer'), 'forbidden');
    await refused(assignDefect(viewer, project, defect, 'A. Iyer'), 'forbidden');
  });
});
