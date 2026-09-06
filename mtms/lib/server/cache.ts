import type { Snapshot } from '../shared/views';

/**
 * The snapshot cache.
 *
 * `buildSnapshot` is one projection per project — read constantly, written rarely — which
 * is exactly the shape the design wants Redis in front of. The code was already written as
 * a single function to make this drop in.
 *
 * Two rules keep it honest:
 *
 * 1. **The key carries the revision.** A cached entry is only ever served for the store
 *    revision it was built from, so a stale read is not possible: after a write the old key
 *    is simply never asked for again. There is no invalidation to get wrong.
 * 2. **The key carries the user.** A snapshot contains that user's permission set and
 *    their members list. Caching per project alone would serve an admin's view to a viewer,
 *    which is the classic way a cache becomes a security bug.
 *
 * Without `REDIS_URL` this is an in-process LRU, which is still worth having: it collapses
 * the several projections a single page render would otherwise do.
 */

export interface SnapshotCache {
  readonly kind: 'memory' | 'redis';
  get(key: string): Promise<Snapshot | null>;
  set(key: string, value: Snapshot): Promise<void>;
  close?(): Promise<void>;
}

export function cacheKey(input: {
  tenantId: string;
  projectId: string;
  userId: string;
  revision: number;
}): string {
  return `mtms:snapshot:${input.tenantId}:${input.projectId}:${input.userId}:r${input.revision}`;
}

/** Small on purpose: entries die at the next write anyway, so a big one would only hold rubbish. */
const MEMORY_LIMIT = 64;

class MemoryCache implements SnapshotCache {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, Snapshot>();

  async get(key: string): Promise<Snapshot | null> {
    const hit = this.entries.get(key);
    if (!hit) return null;
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  async set(key: string, value: Snapshot): Promise<void> {
    this.entries.set(key, value);
    while (this.entries.size > MEMORY_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  quit(): Promise<unknown>;
}

/**
 * Redis, loaded through a variable specifier so `ioredis` stays optional.
 *
 * The TTL is a safety net, not the correctness mechanism — revision-keyed entries are
 * already immutable. It exists so keys from old revisions expire instead of accumulating.
 *
 * NOT YET RUN AGAINST A SERVER — there is none on the development machine. See pending.md.
 */
class RedisCache implements SnapshotCache {
  readonly kind = 'redis' as const;
  private client: RedisLike | null = null;

  constructor(
    private readonly url: string,
    private readonly ttlSeconds = Number(process.env.REDIS_TTL_SECONDS) || 900,
  ) {}

  private async connect(): Promise<RedisLike> {
    if (this.client) return this.client;
    const specifier = 'ioredis';
    let module: { default: new (url: string) => RedisLike };
    try {
      module = (await import(/* @vite-ignore */ specifier)) as never;
    } catch {
      throw new Error(
        'REDIS_URL is set but `ioredis` is not installed. Run `npm install ioredis`, or unset REDIS_URL.',
      );
    }
    this.client = new module.default(this.url);
    return this.client;
  }

  async get(key: string): Promise<Snapshot | null> {
    try {
      const raw = await (await this.connect()).get(key);
      return raw ? (JSON.parse(raw) as Snapshot) : null;
    } catch (error) {
      // A cache that is down must never take the app down with it.
      console.warn('[cache] redis read failed, falling through to the store', error);
      return null;
    }
  }

  async set(key: string, value: Snapshot): Promise<void> {
    try {
      await (await this.connect()).set(key, JSON.stringify(value), 'EX', this.ttlSeconds);
    } catch (error) {
      console.warn('[cache] redis write failed, continuing uncached', error);
    }
  }

  async close(): Promise<void> {
    await this.client?.quit();
    this.client = null;
  }
}

let cache: SnapshotCache | null = null;

export function snapshotCache(): SnapshotCache {
  if (cache) return cache;
  const url = process.env.REDIS_URL;
  cache = url ? new RedisCache(url) : new MemoryCache();
  return cache;
}

/** Test seam. */
export function setSnapshotCache(next: SnapshotCache | null): void {
  cache = next;
}
