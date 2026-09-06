import path from 'node:path';
import type {
  AuditEntry,
  Cell,
  Defect,
  DeliverableColumn,
  DomainEvent,
  DriftDeliverable,
  DriftObservation,
  DriftPromotion,
  DriftReport,
  Invitation,
  Link,
  Membership,
  Module,
  ModuleLibraryEntry,
  PlatformAuditEntry,
  Project,
  ProjectConfig,
  RefreshToken,
  Role,
  Run,
  Subactivity,
  Tenant,
  UserWithSecret,
} from '../shared/domain';
import { RevisionConflict, type StoreDriver } from './storage/driver';
import { FileDriver } from './storage/file-driver';

/**
 * The store.
 *
 * One JSON document, read into memory and written back through a serialised queue. Where
 * it lives is a driver's business (`lib/server/storage/`): the file by default, Postgres
 * when `DATABASE_URL` is set.
 *
 * Concurrency is optimistic rather than exclusive. Each read carries the revision it saw;
 * a write states the revision it expects to replace, and a driver refuses if that is stale.
 * `mutate()` then re-reads and **re-runs the callback** against fresh data, so a change
 * lands on top of a concurrent one rather than over it. Callbacks must therefore be safe to
 * run more than once — in practice they only touch the store they are handed.
 *
 * The narrow `cells` table is the part that matters for the relational move: one row per
 * (module, subactivity, column), never a wide row per module, because columns are
 * user-configurable. `storage/schema.sql` is that target.
 */

export interface StoreData {
  version: number;
  /** Bumped by the driver on every write. Optimistic concurrency turns on this. */
  revision: number;
  tenants: Tenant[];
  users: UserWithSecret[];
  refresh_tokens: RefreshToken[];
  roles: Role[];
  memberships: Membership[];
  invitations: Invitation[];
  projects: Project[];
  project_config: ProjectConfig[];
  columns: DeliverableColumn[];
  modules: Module[];
  subactivities: Subactivity[];
  cells: Cell[];
  audit: AuditEntry[];
  platform_audit: PlatformAuditEntry[];
  library: ModuleLibraryEntry[];
  defects: Defect[];
  links: Link[];
  runs: Run[];
  drift_deliverables: DriftDeliverable[];
  drift_observations: DriftObservation[];
  drift_reports: DriftReport[];
  drift_promotions: DriftPromotion[];
  /** The outbox. Domain events wait here until a consumer drains them. */
  events: DomainEvent[];
}

/**
 * 2: `cell_audit` became `audit`, carrying structural changes as well as cell changes.
 * 3: drift stopped being pre-computed rows — hashes are reported observations.
 * 4: added `revision` (optimistic concurrency), `refresh_tokens` and the `events` outbox.
 * 5: added `users.is_super_admin` and the `platform_audit` feed.
 */
export const STORE_VERSION = 5;

/** How many times a mutation is re-applied before a conflict is given up on. */
const MAX_CONFLICT_RETRIES = 5;

function storePath(): string {
  return (
    process.env.TRACKER_STORE_PATH ??
    path.join(process.env.TRACKER_DATA_DIR ?? path.join(process.cwd(), 'data'), 'tracker.json')
  );
}

let driver: StoreDriver | null = null;
let cache: { data: StoreData; revision: number } | null = null;
/** Every write chains onto this, so two requests in one process cannot interleave. */
let writeChain: Promise<void> = Promise.resolve();

/** File by default; Postgres when a connection string is configured. */
export function storeDriver(): StoreDriver {
  if (driver) return driver;

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    // Required lazily so a file-store deployment never loads the Postgres code path.
    const { PostgresDriver } = require('./storage/postgres-driver') as typeof import('./storage/postgres-driver');
    driver = new PostgresDriver(databaseUrl);
  } else {
    driver = new FileDriver(storePath());
  }
  return driver;
}

async function load(): Promise<{ data: StoreData; revision: number }> {
  if (cache) return cache;

  const stored = await storeDriver().read();

  if (stored) {
    if (stored.data.version === STORE_VERSION) {
      cache = stored;
      return cache;
    }
    // A version bump means the seed shape changed under a store written by an older build.
    // Reseeding is right for a pilot; a migration list replaces this before real data.
    console.warn(
      `[store] on-disk version ${stored.data.version} does not match ${STORE_VERSION} — reseeding`,
    );
  }

  const { buildSeed } = await import('./seed');
  const seeded = await buildSeed();

  try {
    const revision = await storeDriver().write(seeded, stored?.revision ?? 0);
    cache = { data: seeded, revision };
    return cache;
  } catch (error) {
    if (!(error instanceof RevisionConflict)) throw error;

    // Somebody else seeded first. This is not a failure — it is two processes starting
    // against an empty store at the same moment, which happens every time a static export
    // prerenders pages in parallel workers, and would happen to two app instances booting
    // together. Take their document rather than fighting for ours; the seed is the same.
    const theirs = await storeDriver().read();
    if (!theirs) throw error;
    cache = theirs;
    return cache;
  }
}

export async function getStore(): Promise<StoreData> {
  return (await load()).data;
}

/**
 * Applies a mutation and persists it. Mutations run one at a time within a process, and
 * are retried against fresh data if another process wrote first.
 */
export async function mutate<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T> {
  const run = writeChain.then(async () => {
    for (let attempt = 1; ; attempt++) {
      const current = await load();
      const result = await fn(current.data);

      try {
        const revision = await storeDriver().write(current.data, current.revision);
        cache = { data: current.data, revision };
        return result;
      } catch (error) {
        if (!(error instanceof RevisionConflict) || attempt >= MAX_CONFLICT_RETRIES) throw error;
        // Drop the stale document, including the edits just applied to it, and start over
        // from what the other writer left behind.
        cache = null;
        console.warn(`[store] ${error.message} Re-applying (attempt ${attempt + 1}).`);
      }
    }
  });

  // Keep the chain alive even when this mutation rejects, or one failed write would wedge
  // every later one.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}

/** Test seam: drops the in-memory copy so the next read comes from the driver. */
export function resetStoreCache(): void {
  cache = null;
}

/** Test seam: swaps the driver, e.g. for an in-memory Postgres. */
export function setStoreDriver(next: StoreDriver | null): void {
  driver = next;
  cache = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}
