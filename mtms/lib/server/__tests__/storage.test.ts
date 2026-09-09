import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey } from '../cache';
import { drainEvents, setEventPublisher, type EventPublisher } from '../events';
import { advanceCell, buildSnapshot, createDefect, signOffFni } from '../service';
import { getStore, mutate, resetStoreCache, setStoreDriver } from '../store';
import { endSession, rotateSession, startSession } from '../sessions';
import { RevisionConflict, type StoreDriver } from '../storage/driver';
import type { StoreData } from '../store';
import {
  ADMIN,
  DEVOPS,
  MODULE_FULL,
  MODULE_NOT_STARTED,
  actorFor,
  moduleId,
  projectId,
  refused,
  useSeededStore,
} from './harness';

/**
 * Part 6: the machinery that makes more than one process safe.
 *
 * The Postgres and Kafka and Redis drivers themselves are unverified — there is no server
 * on this machine — but the contracts they implement are testable, and that is where the
 * bugs would be: retry-on-conflict, refresh rotation, outbox draining.
 */

beforeEach(async () => {
  await useSeededStore();
  setStoreDriver(null);
  setEventPublisher(null);
});

describe('optimistic concurrency', () => {
  /**
   * A driver that lets exactly one write through, then reports that somebody else moved
   * the store on — which is what a second process looks like.
   */
  function conflictingDriver(realData: StoreData, conflictsRemaining: number): StoreDriver {
    let revision = 1;
    let conflicts = conflictsRemaining;
    return {
      kind: 'file',
      async read() {
        return { data: structuredClone(realData), revision };
      },
      async write(data, expectedRevision) {
        if (conflicts > 0) {
          conflicts--;
          revision += 1;
          throw new RevisionConflict(expectedRevision, revision);
        }
        revision = expectedRevision + 1;
        Object.assign(realData, structuredClone(data));
        return revision;
      },
    };
  }

  it('re-applies a mutation against fresh data when another writer got there first', async () => {
    const seeded = structuredClone(await getStore());
    let attempts = 0;

    setStoreDriver(conflictingDriver(seeded, 2));
    resetStoreCache();

    const result = await mutate((store) => {
      attempts++;
      store.projects[0]!.description = `attempt ${attempts}`;
      return attempts;
    });

    // Two conflicts, so the callback ran three times and the last one is what landed.
    expect(attempts).toBe(3);
    expect(result).toBe(3);
    expect(seeded.projects[0]!.description).toBe('attempt 3');
  });

  it('gives up rather than looping forever when conflicts never clear', async () => {
    const seeded = structuredClone(await getStore());
    setStoreDriver(conflictingDriver(seeded, Number.MAX_SAFE_INTEGER));
    resetStoreCache();

    await expect(mutate((store) => store.projects.length)).rejects.toBeInstanceOf(RevisionConflict);
  });

  it('does not keep the edits made during a losing attempt', async () => {
    const seeded = structuredClone(await getStore());
    setStoreDriver(conflictingDriver(seeded, 1));
    resetStoreCache();

    let attempt = 0;
    await mutate((store) => {
      attempt++;
      // The first attempt appends; if the retry started from the dirty document there
      // would be two entries rather than one.
      store.project_config[0]!.owners.push(`owner ${attempt}`);
    });

    const owners = seeded.project_config[0]!.owners;
    expect(owners.filter((owner) => owner.startsWith('owner '))).toEqual(['owner 2']);
  });

  it('advances the revision on every successful write', async () => {
    const before = (await getStore()).revision;
    await mutate((store) => {
      store.projects[0]!.description = 'moved';
    });
    expect((await getStore()).revision).toBe(before + 1);
  });
});

describe('the snapshot cache key', () => {
  const base = { tenantId: 't', projectId: 'p', userId: 'u', revision: 4 };

  it('changes when the store moves, so a stale entry can never be asked for', () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, revision: 5 }));
  });

  it('changes per user, because a snapshot carries that user’s permissions', () => {
    // The failure this prevents: an admin's cached view being served to a viewer.
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, userId: 'someone-else' }));
  });

  it('changes per project', () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, projectId: 'other' }));
  });
});

describe('refresh tokens', () => {
  async function session() {
    return startSession(await actorFor(ADMIN));
  }

  it('rotates: the presented token is spent and a successor issued', async () => {
    const first = await session();
    const second = await rotateSession(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
  });

  it('revokes the whole family when a spent token comes back', async () => {
    const first = await session();
    const second = await rotateSession(first.refreshToken);

    // The replay itself is refused...
    await refused(rotateSession(first.refreshToken), 'unauthenticated');

    // ...and so is the legitimate successor, because there is no way to tell which
    // holder is honest. Losing the session is the correct price for that ambiguity.
    await refused(rotateSession(second.refreshToken), 'unauthenticated');
  });

  it('refuses an unknown token', async () => {
    await refused(rotateSession('not-a-real-token'), 'unauthenticated');
  });

  it('refuses an expired token and does not issue a successor', async () => {
    const first = await session();
    await mutate((store) => {
      for (const token of store.refresh_tokens) {
        token.expires_at = new Date(Date.now() - 1000).toISOString();
      }
    });

    await refused(rotateSession(first.refreshToken), 'unauthenticated');
    expect((await getStore()).refresh_tokens.every((token) => token.revoked_at)).toBe(true);
  });

  it('signing out revokes the family, not just the token in hand', async () => {
    const first = await session();
    const second = await rotateSession(first.refreshToken);

    await endSession(second.refreshToken);
    await refused(rotateSession(second.refreshToken), 'unauthenticated');
  });

  it('stores only the hash, so a leaked store cannot be replayed', async () => {
    const first = await session();
    const stored = (await getStore()).refresh_tokens;

    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).not.toBe(first.refreshToken);
    expect(stored[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the event outbox', () => {
  function capturingPublisher() {
    const published: string[] = [];
    const publisher: EventPublisher = {
      kind: 'log',
      async publish(events) {
        published.push(...events.map((event) => event.name));
      },
    };
    return { publisher, published };
  }

  it('records cell.changed inside the same write as the change', async () => {
    const actor = await actorFor(ADMIN);
    await advanceCell(actor, await projectId(), {
      moduleId: await moduleId(MODULE_NOT_STARTED),
      subactivityId: null,
      columnKey: 'filecr',
    });

    const events = (await getStore()).events;
    expect(events.map((event) => event.name)).toContain('cell.changed');
    expect(events[0]?.published_at).toBeNull();
  });

  it('partitions by module, so one module’s changes stay in order', async () => {
    const actor = await actorFor(ADMIN);
    const id = await moduleId(MODULE_NOT_STARTED);
    await advanceCell(actor, await projectId(), { moduleId: id, subactivityId: null, columnKey: 'filecr' });
    await advanceCell(actor, await projectId(), { moduleId: id, subactivityId: null, columnKey: 'clicr' });

    const keys = (await getStore()).events.map((event) => event.partition_key);
    expect(new Set(keys)).toEqual(new Set([id]));
  });

  it('records defect.raised and module.closed', async () => {
    const actor = await actorFor(ADMIN);
    await createDefect(actor, await projectId(), {
      moduleId: await moduleId(MODULE_FULL),
      phase: 'Prod deployment',
      ticketKey: 'CRAUT-1',
      childReqId: '',
      severity: 'High',
      description: 'something went wrong',
    });
    await signOffFni(actor, await projectId(), await moduleId(MODULE_FULL), true);

    const names = (await getStore()).events.map((event) => event.name);
    expect(names).toContain('defect.raised');
    expect(names).toContain('module.closed');
  });

  it('marks events published once the publisher accepts them', async () => {
    const { publisher, published } = capturingPublisher();
    setEventPublisher(publisher);

    const actor = await actorFor(ADMIN);
    await advanceCell(actor, await projectId(), {
      moduleId: await moduleId(MODULE_NOT_STARTED),
      subactivityId: null,
      columnKey: 'filecr',
    });

    const result = await drainEvents();
    expect(result.published).toBe(1);
    expect(published).toEqual(['cell.changed']);
    expect((await getStore()).events.every((event) => event.published_at)).toBe(true);
  });

  it('leaves an event pending when the broker refuses, and retries it later', async () => {
    let attempts = 0;
    setEventPublisher({
      kind: 'kafka',
      async publish() {
        attempts++;
        if (attempts === 1) throw new Error('broker unreachable');
      },
    });

    const actor = await actorFor(ADMIN);
    await advanceCell(actor, await projectId(), {
      moduleId: await moduleId(MODULE_NOT_STARTED),
      subactivityId: null,
      columnKey: 'filecr',
    });

    const failed = await drainEvents();
    expect(failed.failed).toBe(1);
    const pending = (await getStore()).events[0]!;
    expect(pending.published_at).toBeNull();
    expect(pending.last_error).toContain('broker unreachable');

    // The store write already happened; the publish catches up on the next drain.
    const second = await drainEvents();
    expect(second.published).toBe(1);
  });

  it('publishes nothing when there is nothing pending', async () => {
    const { publisher } = capturingPublisher();
    setEventPublisher(publisher);
    expect(await drainEvents()).toEqual({ published: 0, failed: 0 });
  });
});

describe('the projection still matches after all of this', () => {
  it('holds the seeded numbers', async () => {
    const actor = await actorFor(DEVOPS);
    const snapshot = buildSnapshot(await getStore(), actor, await projectId());

    expect(snapshot.modules).toHaveLength(18);
    expect(snapshot.config.columns).toHaveLength(14);
    expect(snapshot.modules.filter((module) => module.readiness === 100)).toHaveLength(3);
  });
});
