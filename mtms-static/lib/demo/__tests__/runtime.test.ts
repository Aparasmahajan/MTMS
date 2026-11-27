import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/client/api';
import { buildDemoSnapshot } from '@/lib/server/demo-snapshot';
import { blankProjectSnapshot } from '@/lib/demo/workspace';
import { demoRequest, demoSnapshot, resetDemo, switchDemoRole } from '@/lib/demo/runtime';
import { columnTimings } from '@/lib/shared/derive';
import { nextStatus, toneOf } from '@/lib/shared/vocabulary';
import type { Snapshot } from '@/lib/shared/views';
import { useSeededStore } from '@/lib/server/__tests__/harness';

/**
 * The static demo's stand-in server, exercised directly.
 *
 * Built from the real build-time projection, so these run against the same snapshot the
 * exported site bakes into its HTML. `persistence.ts` no-ops outside a browser, so nothing
 * here touches storage.
 */

let seed: Snapshot;

beforeEach(async () => {
  await useSeededStore();
  seed = await buildDemoSnapshot();
  resetDemo(seed);
});

function call(path: string, method: string, body: Record<string, unknown> = {}) {
  const result = demoRequest(`/api/v1/${path}`, method, body);
  return { snapshot: result.data as Snapshot, meta: result.meta };
}

function refusal(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the demo to refuse');
}

function firstEntry(snapshot: Snapshot) {
  for (const subModule of snapshot.sub_modules) {
    for (const list of subModule.step_lists) {
      const entry = list.entries.find((candidate) => candidate.state === 'todo' && candidate.can_tick);
      if (entry) return { subModule, list, entry };
    }
  }
  throw new Error('the seed has no tickable step');
}

describe('the demo answers every request the screens make', () => {
  it('ticks a checklist step, records it, and returns a fresh snapshot', () => {
    const { entry } = firstEntry(demoSnapshot());
    const { snapshot } = call(`steps/entries/${entry.id}`, 'PATCH', { state: 'done' });

    const after = snapshot.sub_modules
      .flatMap((subModule) => subModule.step_lists)
      .flatMap((list) => list.entries)
      .find((candidate) => candidate.id === entry.id);
    expect(after?.state).toBe('done');
    expect(after?.history[0]?.to).toBe('done');
    expect(snapshot.audit[0]?.label).toBe('STEPS');
  });

  it('refuses a block without a reason', () => {
    const { entry } = firstEntry(demoSnapshot());
    const error = refusal(() => call(`steps/entries/${entry.id}`, 'PATCH', { state: 'blocked' }));
    expect(error.code).toBe('validation_failed');
  });

  it('re-gates every checklist when the role switcher moves', () => {
    const { entry } = firstEntry(demoSnapshot());
    const viewer = demoSnapshot().roles.find((role) => role.key === 'viewer');
    expect(viewer).toBeDefined();

    const asViewer = switchDemoRole(viewer!.id);
    const gated = asViewer.sub_modules
      .flatMap((subModule) => subModule.step_lists)
      .flatMap((list) => list.entries);
    expect(gated.every((candidate) => !candidate.can_tick)).toBe(true);
    expect(gated.every((candidate) => candidate.locked_reason.length > 0)).toBe(true);

    const error = refusal(() => call(`steps/entries/${entry.id}`, 'PATCH', { state: 'done' }));
    expect(error.code).toBe('forbidden');
  });

  it('raises a discussion topic with an opening comment', () => {
    const target = demoSnapshot().sub_modules[0]!;
    const { snapshot } = call('discussions/threads', 'POST', {
      scope_type: 'sub_module',
      scope_id: target.id,
      topic: 'Who owns the rollback?',
      body: 'Asking before the window opens.',
    });
    const thread = snapshot.sub_modules.find((row) => row.id === target.id)?.threads[0];
    expect(thread?.topic).toBe('Who owns the rollback?');
    expect(thread?.comments).toHaveLength(1);
  });

  it('adds a column with the name the Configure screen sends', () => {
    const { snapshot } = call('config/columns', 'POST', {
      key: 'smoke_test',
      label: 'SMOKE TEST',
      full: 'Smoke test',
      allowed: ['notloaded', 'loaded'],
      counts: true,
    });
    const column = snapshot.config.columns.find((candidate) => candidate.key === 'smoke_test');
    expect(column?.label).toBe('SMOKE TEST');
    expect(column?.full).toBe('Smoke test');
    expect(snapshot.sub_modules.every((row) => row.cells.some((cell) => cell.column_key === 'smoke_test'))).toBe(true);
  });

  it('adds a grouped deliverable, one column per environment', () => {
    const environments = demoSnapshot().config.environments;
    const { snapshot } = call('config/columns/grouped', 'POST', {
      group_key: 'smoke',
      group_label: 'SMOKE',
      full: 'Smoke',
      allowed: ['notloaded', 'lab', 'preprod', 'prod'],
    });
    const added = snapshot.config.columns.filter((column) => column.group_key === 'smoke');
    expect(added).toHaveLength(environments.length);
    expect(added.filter((column) => column.counts).map((column) => column.environment)).toEqual(['prod']);
  });

  it('refuses a module with no name or an unknown node type', () => {
    expect(refusal(() => call('modules', 'POST', { module_name: 'CFX', name: '' })).code).toBe('validation_failed');
    expect(refusal(() => call('modules', 'POST', { module_name: 'NOPE', name: 'x' })).code).toBe('validation_failed');
  });

  it('answers the sub-module screen at /sub-modules', () => {
    const target = demoSnapshot().sub_modules.find((row) => !row.closed)!;
    const { snapshot } = call(`sub-modules/${target.id}`, 'PATCH', { fni_target_date: '2027-01-15' });
    expect(snapshot.sub_modules.find((row) => row.id === target.id)?.fni_target_date).toBe('2027-01-15');
  });

  it('marks notifications read and recounts the badge', () => {
    expect(demoSnapshot().unread_notifications).toBeGreaterThan(0);
    const { snapshot } = call('notifications/read', 'POST');
    expect(snapshot.unread_notifications).toBe(0);
  });

  it('recomputes the module figures and the timing panel after a cell changes', () => {
    const before = demoSnapshot();
    // Any own-row cell one click away from done — found rather than named, so the test does
    // not depend on which statuses the seed happens to hold.
    let row: Snapshot['sub_modules'][number] | undefined;
    let columnKey = '';
    for (const candidate of before.sub_modules) {
      if (candidate.sub_activities.length > 0 || candidate.closed) continue;
      for (const cell of candidate.cells) {
        const column = before.config.columns.find((entry) => entry.key === cell.column_key);
        if (!column?.active || toneOf(cell.status) === 'done') continue;
        if (toneOf(nextStatus(cell.status, column.allowed)) === 'done') {
          row = candidate;
          columnKey = column.key;
          break;
        }
      }
      if (row) break;
    }
    expect(row).toBeDefined();
    const measuredBefore = before.timing.find((entry) => entry.column_key === columnKey)?.measured ?? 0;

    const { snapshot } = call('cells', 'PATCH', {
      sub_module_id: row!.id,
      sub_activity_id: null,
      column_key: columnKey,
    });
    const measuredAfter = snapshot.timing.find((entry) => entry.column_key === columnKey)?.measured ?? 0;
    expect(measuredAfter).toBe(measuredBefore + 1);

    const module = snapshot.config.modules.find((entry) => entry.name === row!.module_name);
    const mine = snapshot.sub_modules.filter((candidate) => candidate.module_name === row!.module_name);
    expect(module?.readiness).toBe(
      Math.round(mine.reduce((total, candidate) => total + candidate.readiness, 0) / mine.length),
    );
  });

  it('still refuses loudly what it has no handler for', () => {
    expect(refusal(() => call('nothing/here', 'POST')).code).toBe('not_found');
  });

  it('signs in without a project, and explains an invitation link', () => {
    expect(demoRequest('/api/v1/auth/login', 'POST', {}).meta.demo).toBe(true);
    expect(refusal(() => demoRequest('/api/v1/auth/accept-invite', 'POST', {})).code).toBe('bad_request');
  });
});

describe('the shared timing rule', () => {
  it('measures a sub-module with sub-activities from its sub-activity cells', () => {
    const column = {
      id: 'c',
      project_id: 'p',
      key: 'k',
      label: 'PROD',
      full: 'K in prod',
      allowed: ['notloaded', 'prod'],
      counts: true,
      order_index: 0,
      environment: 'prod',
      group_key: 'k',
      group_label: 'K',
    };
    const subject = {
      created_at: '2026-01-01T00:00:00.000Z',
      cells: [{ column_key: 'k', status: '', changed_at: null }],
      sub_activities: [
        { cells: [{ column_key: 'k', status: 'prod', changed_at: '2026-01-03T00:00:00.000Z' }] },
        { cells: [{ column_key: 'k', status: 'prod', changed_at: '2026-01-05T00:00:00.000Z' }] },
      ],
    };
    const [timing] = columnTimings([column], [subject]);
    expect(timing?.measured).toBe(1);
    expect(timing?.outstanding).toBe(0);
    // Finished when the last sub-activity got there.
    expect(timing?.median_days).toBe(4);
    // A grouped column is named with its deliverable, so three PROD rows can be told apart.
    expect(timing?.label).toBe('K·PROD');
  });
});

describe('a project in another organisation', () => {
  it('inherits none of this organisation’s people, roles or steps', () => {
    const blank = blankProjectSnapshot(
      seed,
      { id: 'p2', key: 'OTHER', name: 'Other' },
      { id: 'org-b', name: 'Org B', admins: [{ display_name: 'Bea', email: 'bea@b.io', status: 'invited' }] },
    );
    expect(blank.users.map((user) => user.email)).toEqual(['bea@b.io']);
    expect(blank.roles.every((role) => !seed.roles.some((seeded) => seeded.id === role.id))).toBe(true);
    expect(blank.invitations).toEqual([]);
    expect(blank.step_library).toEqual([]);
    expect(blank.timing).toEqual([]);
    expect(blank.step_timing).toEqual([]);
  });
});
