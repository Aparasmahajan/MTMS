import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DriftEnvironment } from '../../shared/domain';
import { compositeHash, verdictFor } from '../drift';
import { buildSnapshot, ingestDriftReport, promoteDrift } from '../service';
import { getStore, mutate } from '../store';
import { ADMIN, DEVOPS, VIEWER, actorFor, projectId, refused, useSeededStore } from './harness';

/**
 * Drift.
 *
 * Every rule here corresponds to a failure that has already cost this project time, so
 * the tests are named after the failure rather than after the function.
 */

const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');

async function snapshot(email = ADMIN) {
  const actor = await actorFor(email);
  return buildSnapshot(await getStore(), actor, await projectId());
}

async function rowFor(columnKey: string) {
  const row = (await snapshot()).drift.rows.find((candidate) => candidate.column_key === columnKey);
  if (!row) throw new Error(`No drift row for ${columnKey}`);
  return row;
}

function warningKinds(warnings: { kind: string }[]): string[] {
  return warnings.map((warning) => warning.kind);
}

/** Reports one hash per deliverable for an environment, so a whole set can be set up. */
async function report(
  environment: DriftEnvironment,
  hashes: Record<string, string | undefined>,
  extra: Record<string, Partial<Record<string, unknown>>> = {},
) {
  const entries = Object.entries(hashes)
    .filter(([, value]) => value !== undefined)
    .map(([columnKey, value]) => ({
      column_key: columnKey,
      layer: 'yaml' as const,
      path: `CLICR/ANY/V1/${columnKey}.yaml`,
      content_hash: sha(value as string),
      ...(extra[columnKey] ?? {}),
    }));

  return ingestDriftReport(await projectId(), {
    environment,
    agent: `test-agent/${environment}`,
    entries: entries as never,
  });
}

beforeEach(useSeededStore);

describe('identity is the content hash', () => {
  it('rolls several files into one deliverable hash, independent of report order', () => {
    const files = [
      { path: 'b.py', content_hash: sha('two') },
      { path: 'a.py', content_hash: sha('one') },
    ] as never[];
    const reversed = [...files].reverse() as never[];

    expect(compositeHash(files)).toBe(compositeHash(reversed));
  });

  it('changes the deliverable hash when any one file in the set changes', () => {
    const before = [
      { path: 'a.py', content_hash: sha('one') },
      { path: 'b.py', content_hash: sha('two') },
    ] as never[];
    const after = [
      { path: 'a.py', content_hash: sha('one') },
      { path: 'b.py', content_hash: sha('two-changed') },
    ] as never[];

    expect(compositeHash(before)).not.toBe(compositeHash(after));
  });

  it('is null when nothing has been reported, rather than an empty-string hash', () => {
    expect(compositeHash([])).toBeNull();
  });
});

describe('verdicts', () => {
  const hashes = (repo: string | null, lab: string | null, preprod: string | null, prod: string | null) =>
    ({ repo, lab, preprod, prod }) as Record<DriftEnvironment, string | null>;

  it('is In step when every environment agrees', () => {
    expect(verdictFor(hashes('a', 'a', 'a', 'a'))).toBe('In step');
  });

  it('is Prod behind when prod is not what preprod verified', () => {
    expect(verdictFor(hashes('b', 'b', 'b', 'a'))).toBe('Prod behind');
  });

  it('is Patched in place when the servers agree with each other but not the repo', () => {
    expect(verdictFor(hashes('a', 'a', 'b', 'b'))).toBe('Patched in place');
  });

  it('is Never verified when prod has never reported', () => {
    expect(verdictFor(hashes('a', 'a', 'a', null))).toBe('Never verified');
  });

  it('is Not deployed when it exists only in the repo', () => {
    expect(verdictFor(hashes('a', null, null, null))).toBe('Not deployed');
  });

  it('never reads as In step on the strength of a missing prod hash', () => {
    // The failure this prevents: absence of data rendering as agreement.
    expect(verdictFor(hashes(null, null, null, null))).not.toBe('In step');
    expect(verdictFor(hashes('a', 'a', null, null))).not.toBe('In step');
  });
});

describe('the seeded environment', () => {
  it('reproduces the failures the engineer actually hit', async () => {
    const rows = (await snapshot()).drift.rows;
    const verdicts = Object.fromEntries(rows.map((row) => [row.column_key, row.verdict]));

    expect(verdicts.clicr).toBe('Prod behind');
    expect(verdicts.bst).toBe('Patched in place');
    expect(verdicts.json).toBe('Never verified');
    expect(verdicts.valid).toBe('In step');
  });

  it('raises the shared-deliverable warning at High, because it lands on every flavour', async () => {
    const warnings = (await snapshot()).drift.warnings;
    const neverVerified = warnings.find((warning) => warning.id === 'never_verified:json');

    expect(neverVerified?.severity).toBe('High');
    expect(neverVerified?.text).toContain('shared');
  });

  it('spots a jar compiled before its source last changed', async () => {
    const warnings = (await snapshot()).drift.warnings;
    expect(warningKinds(warnings)).toContain('stale_compile');
  });

  it('spots a file that is in the repo and not in .packinglist', async () => {
    const warnings = (await snapshot()).drift.warnings;
    const notListed = warnings.find((warning) => warning.kind === 'not_in_packinglist');

    expect(notListed).toBeDefined();
    expect(notListed?.text).toContain('does not deploy');
  });

  it('flags modules recording a deliverable as done in prod while its hash has drifted', async () => {
    const warnings = (await snapshot()).drift.warnings;
    const contradicted = warnings.find((warning) => warning.kind === 'claimed_but_drifted');

    // The seed has modules with CLICR loaded in prod, and prod's CLICR is an older build.
    expect(contradicted).toBeDefined();
    expect(contradicted?.text).toContain('not evidence');
  });

  it('sorts High warnings above Med', async () => {
    const warnings = (await snapshot()).drift.warnings;
    const firstMed = warnings.findIndex((warning) => warning.severity === 'Med');
    const lastHigh = warnings.map((warning) => warning.severity).lastIndexOf('High');

    if (firstMed >= 0 && lastHigh >= 0) expect(lastHigh).toBeLessThan(firstMed);
  });
});

describe('ingest', () => {
  it('replaces an environment rather than merging, so a deleted file disappears', async () => {
    await report('prod', { clicr: 'x', valid: 'x', exec: 'x', json: 'x', html: 'x', bst: 'x', filecr: 'x' });
    expect((await rowFor('json')).verdict).not.toBe('Never verified');

    // The next report omits json — the file is gone from that server.
    await report('prod', { clicr: 'x', valid: 'x', exec: 'x', html: 'x', bst: 'x', filecr: 'x' });
    expect((await rowFor('json')).verdict).toBe('Never verified');
  });

  it('ignores columns the project does not track instead of rejecting the whole report', async () => {
    const result = await ingestDriftReport(await projectId(), {
      environment: 'lab',
      agent: 'test-agent',
      entries: [
        { column_key: 'valid', layer: 'yaml', path: 'v.yaml', content_hash: sha('v') },
        { column_key: 'not_a_column', layer: 'yaml', path: 'x.yaml', content_hash: sha('x') },
      ],
    });

    expect(result.accepted).toBe(1);
    expect(result.ignored).toEqual(['not_a_column']);
  });

  it('records who reported what, so an environment can answer "when did anyone last look"', async () => {
    await report('prod', { valid: 'z' });
    const reports = (await snapshot()).drift.reports;
    const prod = reports.find((entry) => entry.environment === 'prod');

    expect(prod?.agent).toBe('test-agent/prod');
    expect(prod?.observation_count).toBe(1);
  });

  it('writes an audit entry, so a hash change is attributable like any other change', async () => {
    await report('prod', { valid: 'z' });
    const audit = (await snapshot()).audit;

    expect(audit[0]?.label).toBe('DRIFT');
    expect(audit[0]?.who).toBe('test-agent/prod');
  });

  it('lowercases the hash, so a hex-uppercase agent does not read as drift', async () => {
    const hash = sha('same');
    const entry = (casing: string) => [
      { column_key: 'valid', layer: 'yaml' as const, path: 'v.yaml', content_hash: casing },
    ];

    // Every environment holds the same bytes; only the hex casing differs.
    await ingestDriftReport(await projectId(), { environment: 'repo', agent: 'a', entries: entry(hash) });
    await ingestDriftReport(await projectId(), { environment: 'lab', agent: 'b', entries: entry(hash) });
    await ingestDriftReport(await projectId(), {
      environment: 'preprod',
      agent: 'c',
      entries: entry(hash.toUpperCase()),
    });
    await ingestDriftReport(await projectId(), { environment: 'prod', agent: 'd', entries: entry(hash) });

    expect((await rowFor('valid')).verdict).toBe('In step');
  });
});

describe('the promotion gate', () => {
  /** Puts every environment in step and every module fully done, so the gate can open. */
  async function openTheGate() {
    const store = await getStore();
    const project = await projectId();

    await mutate((data) => {
      // Every counted cell done, on modules and subactivities alike.
      const columns = data.columns.filter((column) => column.project_id === project);
      for (const cell of data.cells) {
        const column = columns.find((candidate) => candidate.key === cell.column_key);
        if (!column) continue;
        const done = column.allowed.find((status) =>
          ['created', 'prod', 'loaded', 'completed', 'raised'].includes(status),
        );
        if (done) cell.status = done;
      }
    });

    const tracked = store.drift_deliverables.map((entry) => entry.column_key);
    const agreed = Object.fromEntries(tracked.map((key) => [key, 'agreed']));
    for (const environment of ['repo', 'lab', 'preprod', 'prod'] as const) {
      await report(environment, agreed);
    }
  }

  it('is blocked on the seed, and names every failing check', async () => {
    const gate = (await snapshot()).drift.gate;

    expect(gate.can_promote).toBe(false);
    expect(gate.blocked).toBeGreaterThan(0);
    expect(gate.label).toContain('blocked by');
    expect(gate.checks.every((check) => typeof check.detail === 'string')).toBe(true);
  });

  it('refuses a promotion while any check fails, recomputed from the store', async () => {
    const actor = await actorFor(DEVOPS);
    const error = await refused(promoteDrift(actor, await projectId(), 'preprod', 'prod'), 'bad_request');

    expect(error.message).toContain('Blocked');
  });

  it('opens only when every check passes', async () => {
    await openTheGate();
    const gate = (await snapshot()).drift.gate;

    expect(gate.checks.filter((check) => !check.passed)).toEqual([]);
    expect(gate.can_promote).toBe(true);
  });

  it('needs prod.confirm', async () => {
    await openTheGate();
    const actor = await actorFor(VIEWER);
    await refused(promoteDrift(actor, await projectId(), 'preprod', 'prod'), 'forbidden');
  });

  it('refuses to promote an environment onto itself', async () => {
    await openTheGate();
    const actor = await actorFor(DEVOPS);
    await refused(promoteDrift(actor, await projectId(), 'prod', 'prod'), 'validation_failed');
  });
});

describe('promotion', () => {
  /** Everything in agreement and every cell done, so the gate is open — but no promotion yet. */
  async function readyToPromote() {
    const project = await projectId();
    await mutate((data) => {
      const columns = data.columns.filter((column) => column.project_id === project);
      for (const cell of data.cells) {
        const column = columns.find((candidate) => candidate.key === cell.column_key);
        const done = column?.allowed.find((status) =>
          ['created', 'prod', 'loaded', 'completed', 'raised'].includes(status),
        );
        if (done) cell.status = done;
      }
    });

    const store = await getStore();
    const tracked = store.drift_deliverables.map((entry) => entry.column_key);
    for (const environment of ['repo', 'lab', 'preprod', 'prod'] as const) {
      await report(environment, Object.fromEntries(tracked.map((key) => [key, 'agreed'])));
    }
    return { project, tracked };
  }

  async function promoteWithGateOpen() {
    const { project } = await readyToPromote();
    return promoteDrift(await actorFor(DEVOPS), project, 'preprod', 'prod');
  }

  it('records the promoted hashes without writing any prod observation', async () => {
    const { project } = await readyToPromote();

    const before = (await snapshot()).drift.rows.map((row) => row.full_hashes.prod);
    await promoteDrift(await actorFor(DEVOPS), project, 'preprod', 'prod');
    const after = (await snapshot()).drift.rows.map((row) => row.full_hashes.prod);

    // Promotion is an intent. It must not move prod's recorded hashes on its own.
    expect(after).toEqual(before);
  });

  it('stays unconfirmed until prod reports the promoted hashes back', async () => {
    await promoteWithGateOpen();
    const promotion = (await snapshot()).drift.promotions[0];

    expect(promotion?.confirmed_at).toBeNull();
    expect(promotion?.from_environment).toBe('preprod');
    expect(promotion?.to_environment).toBe('prod');
  });

  it('is confirmed by an agent report that matches, and not by one that does not', async () => {
    await promoteWithGateOpen();
    const store = await getStore();
    const tracked = store.drift_deliverables.map((entry) => entry.column_key);

    // A report that disagrees leaves it open.
    await report('prod', Object.fromEntries(tracked.map((key) => [key, 'something-else'])));
    expect((await snapshot()).drift.promotions[0]?.confirmed_at).toBeNull();

    // The matching one closes it.
    const result = await report('prod', Object.fromEntries(tracked.map((key) => [key, 'agreed'])));
    expect(result.confirmed_promotions).toBe(1);
    expect((await snapshot()).drift.promotions[0]?.confirmed_at).not.toBeNull();
  });
});
