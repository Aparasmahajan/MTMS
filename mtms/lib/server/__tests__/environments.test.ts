import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth';
import {
  advanceCell,
  buildSnapshot,
  confirmLoadedInProd,
  setColumnCounts,
  setEnvironmentEnabled,
} from '../service';
import { getStore } from '../store';
import {
  ADMIN,
  DEVOPS,
  MODULE_FULL,
  MODULE_NOT_STARTED,
  VIEWER,
  actorFor,
  moduleId,
  projectId,
  refused,
  useSeededStore,
} from './harness';

/**
 * A deliverable is loaded onto lab, preprod and prod separately, and the three are not a
 * sequence. Prod can be loaded with lab blank, because lab was down when the window
 * opened — which is the case one status per deliverable could never record, and the
 * reason each environment has its own column.
 *
 * The rules that follow from that are the ones worth pinning down: only prod counts, an
 * environment can be switched off, and switching one off never destroys a cell.
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

async function snapshot() {
  return buildSnapshot(await getStore(), admin, project);
}

async function moduleView(name: string) {
  const view = (await snapshot()).modules.find((module) => module.name === name);
  if (!view) throw new Error(`No module ${name} in the projection`);
  return view;
}

describe('per-environment columns', () => {
  it('splits a load deliverable into one column per environment, under one group', async () => {
    const columns = (await snapshot()).config.columns;
    const filecr = columns.filter((column) => column.group_key === 'filecr');

    expect(filecr.map((column) => column.key)).toEqual([
      'filecr_lab',
      'filecr_preprod',
      'filecr_prod',
    ]);
    expect(filecr.map((column) => column.label)).toEqual(['LAB', 'PRE', 'PROD']);
    expect(filecr.every((column) => column.group_label === 'FILECR')).toBe(true);
    // A plain Loaded / Not Loaded tick. Which environment it is loaded on is the column,
    // not the status — that is the whole point of the split.
    expect(filecr.every((column) => column.allowed.join() === 'notloaded,loaded')).toBe(true);
  });

  it('records prod loaded with lab never filled in', async () => {
    const module = await moduleId(MODULE_NOT_STARTED);
    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: null,
      columnKey: 'filecr_prod',
      status: 'loaded',
    });

    const cells = (await moduleView(MODULE_NOT_STARTED)).cells;
    const statusOf = (key: string) => cells.find((cell) => cell.column_key === key)?.status;

    expect(statusOf('filecr_prod')).toBe('loaded');
    expect(statusOf('filecr_lab')).toBe('');
    expect(statusOf('filecr_preprod')).toBe('');
  });

  it('counts only the prod column toward readiness', async () => {
    const columns = (await snapshot()).config.columns;
    const counted = columns.filter((column) => column.counts && column.environment);

    expect(counted.every((column) => column.environment === 'prod')).toBe(true);
    // Twelve counted columns, exactly as before the split: six per-environment
    // deliverables contributing their prod column, and six plain ones.
    expect(columns.filter((column) => column.counts)).toHaveLength(12);
  });

  it('reaches 100% with lab and preprod untouched', async () => {
    // MODULE_FULL is loaded everywhere in the seed. Clear its lab and preprod ticks and
    // the module must still read as ready — a release that skipped lab is still in prod.
    for (const key of ['filecr_lab', 'filecr_preprod', 'clicr_lab', 'clicr_preprod']) {
      await advanceCell(admin, project, {
        moduleId: await moduleId(MODULE_FULL),
        subactivityId: null,
        columnKey: key,
        status: 'notloaded',
      });
    }

    expect((await moduleView(MODULE_FULL)).readiness).toBe(100);
  });

  it('does not tick lab and preprod when DevOps confirms the prod load', async () => {
    const module = await moduleId(MODULE_NOT_STARTED);
    await confirmLoadedInProd(devops, project, module);

    const cells = (await moduleView(MODULE_NOT_STARTED)).cells;
    const statusOf = (key: string) => cells.find((cell) => cell.column_key === key)?.status;

    expect(statusOf('filecr_prod')).toBe('loaded');
    // Ticking these would assert two loads nobody performed.
    expect(statusOf('filecr_lab')).toBe('');
    expect(statusOf('filecr_preprod')).toBe('');
  });
});

describe('switching an environment off', () => {
  it('takes its columns off the grid and out of the maths, keeping every cell', async () => {
    const before = await snapshot();
    const labCells = before.modules.flatMap((module) =>
      module.cells.filter((cell) => cell.column_key.endsWith('_lab')),
    );

    await setEnvironmentEnabled(admin, project, 'lab', false);

    const after = await snapshot();
    const lab = after.config.columns.filter((column) => column.environment === 'lab');

    expect(lab).toHaveLength(6);
    expect(lab.every((column) => column.active)).toBe(false);
    expect(after.config.environments.find((entry) => entry.key === 'lab')?.enabled).toBe(false);

    // The cells are still there, holding exactly what they held.
    const stillThere = after.modules.flatMap((module) =>
      module.cells.filter((cell) => cell.column_key.endsWith('_lab')),
    );
    expect(stillThere.map((cell) => cell.status)).toEqual(labCells.map((cell) => cell.status));
  });

  it('leaves readiness alone, because lab never counted', async () => {
    const before = (await snapshot()).modules.map((module) => module.readiness);
    await setEnvironmentEnabled(admin, project, 'lab', false);
    expect((await snapshot()).modules.map((module) => module.readiness)).toEqual(before);
  });

  it('stops counting a hidden environment that had been made to count', async () => {
    await setColumnCounts(admin, project, 'filecr_lab', true);
    const counting = (await moduleView(MODULE_NOT_STARTED)).blank_count;

    await setEnvironmentEnabled(admin, project, 'lab', false);
    expect((await moduleView(MODULE_NOT_STARTED)).blank_count).toBeLessThan(counting);
  });

  it('brings the columns back untouched when switched on again', async () => {
    const before = await snapshot();
    await setEnvironmentEnabled(admin, project, 'preprod', false);
    await setEnvironmentEnabled(admin, project, 'preprod', true);

    const after = await snapshot();
    expect(after.config.columns.map((column) => column.key)).toEqual(
      before.config.columns.map((column) => column.key),
    );
    expect(after.modules.map((module) => module.readiness)).toEqual(
      before.modules.map((module) => module.readiness),
    );
    expect(after.modules.flatMap((module) => module.cells.map((cell) => cell.status))).toEqual(
      before.modules.flatMap((module) => module.cells.map((cell) => cell.status)),
    );
  });

  it('refuses to switch prod off', async () => {
    const error = await refused(
      setEnvironmentEnabled(admin, project, 'prod', false),
      'bad_request',
    );
    expect(error.message).toContain('Prod cannot be switched off');
  });

  it('refuses an environment the project does not have', async () => {
    await refused(setEnvironmentEnabled(admin, project, 'nonsense', false), 'not_found');
  });

  it('refuses a viewer', async () => {
    await refused(setEnvironmentEnabled(viewer, project, 'lab', false), 'forbidden');
  });

  it('records what happened, and that nothing was deleted', async () => {
    await setEnvironmentEnabled(admin, project, 'lab', false);
    const entry = (await snapshot()).audit[0];

    expect(entry?.label).toBe('CONFIG');
    expect(entry?.what).toBe(
      'switched Lab off — its 6 columns leave the matrix and the readiness maths, keeping every cell',
    );
  });
});
