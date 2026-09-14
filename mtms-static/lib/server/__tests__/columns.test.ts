import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth';
import {
  advanceCell,
  buildSnapshot,
  moveColumn,
  setColumnStatuses,
} from '../service';
import { getStore } from '../store';
import {
  ADMIN,
  MODULE_FULL,
  MODULE_PARTIAL_WITH_SUBS,
  VIEWER,
  actorFor,
  moduleId,
  projectId,
  refused,
  useSeededStore,
} from './harness';

/**
 * Part 3.1 and 3.2 — a column's statuses and its position are configuration.
 *
 * The rule that matters here is what a configuration change does to data already
 * recorded: nothing. A cell holding a status its column no longer allows keeps it. The
 * record says a deliverable was loaded in prod, and an edit to a dropdown is not
 * evidence that it was not.
 */

let admin: Actor;
let viewer: Actor;
let project: string;

beforeEach(async () => {
  await useSeededStore();
  admin = await actorFor(ADMIN);
  viewer = await actorFor(VIEWER);
  project = await projectId();
});

async function config() {
  return (buildSnapshot(await getStore(), admin, project)).config;
}

async function column(key: string) {
  const found = (await config()).columns.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`No column ${key}`);
  return found;
}

describe('setting the statuses a column can take', () => {
  it('replaces the subset, keeping the order given', async () => {
    await setColumnStatuses(admin, project, 'bst', ['lab', 'notloaded', 'prod']);
    expect((await column('bst')).allowed).toEqual(['lab', 'notloaded', 'prod']);
  });

  it('removes duplicates', async () => {
    await setColumnStatuses(admin, project, 'bst', ['prod', 'lab', 'prod']);
    expect((await column('bst')).allowed).toEqual(['prod', 'lab']);
  });

  it('refuses a status outside the shared vocabulary', async () => {
    const error = await refused(
      setColumnStatuses(admin, project, 'bst', ['loaded', 'half_loaded']),
      'validation_failed',
    );
    expect(error.message).toContain('half_loaded');
  });

  it('refuses "blank", which is the absence of a status rather than one', async () => {
    await refused(setColumnStatuses(admin, project, 'bst', ['blank']), 'validation_failed');
  });

  it('refuses an empty subset', async () => {
    const error = await refused(setColumnStatuses(admin, project, 'bst', []), 'validation_failed');
    expect(error.message).toBe('A column needs at least one status it can take.');
  });

  it('refuses a viewer', async () => {
    await refused(setColumnStatuses(viewer, project, 'bst', ['loaded']), 'forbidden');
  });

  it('leaves cells that already hold a now-disallowed status exactly as they are', async () => {
    // Four seeded cells hold FNI "Pending": one on 33_LIC_LOADING_IN_SBC, and one on
    // each of the CFX module's three subactivities.
    expect((await column('fni')).off_vocabulary).toBe(0);

    await setColumnStatuses(admin, project, 'fni', ['completed']);

    const store = await getStore();
    const stillPending = store.cells.filter(
      (cell) => cell.column_key === 'fni' && cell.status === 'pending',
    );
    expect(stillPending).toHaveLength(4);
    expect((await column('fni')).off_vocabulary).toBe(4);
  });

  it('does not count blanks as off-vocabulary — a blank is not a status', async () => {
    // Every module carries a blank RITM cell, and no subset can make a blank illegal.
    await setColumnStatuses(admin, project, 'ritm', ['raised']);
    expect((await column('ritm')).off_vocabulary).toBe(0);
  });

  it('moves an orphaned cell into the new subset the next time it is clicked', async () => {
    const module = await moduleId(MODULE_PARTIAL_WITH_SUBS);
    await setColumnStatuses(admin, project, 'fni', ['completed']);

    const snapshot = buildSnapshot(await getStore(), admin, project);
    const view = snapshot.modules.find((candidate) => candidate.id === module)!;
    const first = view.subactivities[0]!;
    expect(first.cells.find((cell) => cell.column_key === 'fni')?.status).toBe('pending');

    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: first.id,
      columnKey: 'fni',
    });

    const after = buildSnapshot(await getStore(), admin, project);
    const updated = after.modules.find((candidate) => candidate.id === module)!;
    expect(updated.subactivities[0]!.cells.find((cell) => cell.column_key === 'fni')?.status).toBe(
      'completed',
    );
    expect(after.config.columns.find((candidate) => candidate.key === 'fni')?.off_vocabulary).toBe(3);
  });

  it('still refuses to write a status the column does not allow', async () => {
    await setColumnStatuses(admin, project, 'bst', ['loaded']);
    const error = await refused(
      advanceCell(admin, project, {
        moduleId: await moduleId(MODULE_FULL),
        subactivityId: null,
        columnKey: 'bst',
        status: 'notloaded',
      }),
      'validation_failed',
    );
    expect(error.message).toContain('It allows: Loaded.');
  });
});

describe('reordering columns', () => {
  it('moves a column one place and keeps the sequence dense', async () => {
    const before = (await config()).columns.map((entry) => entry.key);
    expect(before.slice(0, 3)).toEqual(['oh', 'filecr_lab', 'filecr_preprod']);

    await moveColumn(admin, project, 'filecr_lab', 'up');

    const after = (await config()).columns;
    expect(after.map((entry) => entry.key).slice(0, 3)).toEqual([
      'filecr_lab',
      'oh',
      'filecr_preprod',
    ]);
    expect(after.map((entry) => entry.order_index)).toEqual(after.map((_, index) => index));
  });

  it('moves a column down', async () => {
    await moveColumn(admin, project, 'oh', 'down');
    expect((await config()).columns.map((entry) => entry.key).slice(0, 2)).toEqual([
      'filecr_lab',
      'oh',
    ]);
  });

  it('is reversible', async () => {
    const before = (await config()).columns.map((entry) => entry.key);
    await moveColumn(admin, project, 'json_lab', 'up');
    await moveColumn(admin, project, 'json_lab', 'down');
    expect((await config()).columns.map((entry) => entry.key)).toEqual(before);
  });

  it('refuses to move the first column up or the last one down', async () => {
    const columns = (await config()).columns;
    const first = columns[0]!.key;
    const last = columns[columns.length - 1]!.key;

    expect((await refused(moveColumn(admin, project, first, 'up'), 'bad_request')).message).toBe(
      'That column is already first.',
    );
    expect((await refused(moveColumn(admin, project, last, 'down'), 'bad_request')).message).toBe(
      'That column is already last.',
    );
  });

  it('refuses a column that is not on the project', async () => {
    await refused(moveColumn(admin, project, 'nonsense', 'up'), 'not_found');
  });

  it('refuses a viewer', async () => {
    await refused(moveColumn(viewer, project, 'clicr_lab', 'up'), 'forbidden');
  });

  it('reorders the matrix without touching any cell', async () => {
    const before = buildSnapshot(await getStore(), admin, project);
    const readiness = before.modules.map((module) => module.readiness);

    await moveColumn(admin, project, 'fni', 'up');

    const after = buildSnapshot(await getStore(), admin, project);
    expect(after.modules.map((module) => module.readiness)).toEqual(readiness);
    // Each module's cells follow the new column order.
    for (const module of after.modules) {
      expect(module.cells.map((cell) => cell.column_key)).toEqual(
        after.config.columns.map((entry) => entry.key),
      );
    }
  });
});
