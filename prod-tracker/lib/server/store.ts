import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  AuditEntry,
  Cell,
  Defect,
  DeliverableColumn,
  DriftRow,
  DriftWarning,
  Invitation,
  Link,
  Membership,
  Module,
  ModuleLibraryEntry,
  Project,
  ProjectConfig,
  Role,
  Run,
  Subactivity,
  Tenant,
  UserWithSecret,
} from '../shared/domain';

/**
 * The store.
 *
 * One JSON document on disk, read once into memory and written back through a single
 * serialised queue. That is the same constraint TMS's workbook store lives under —
 * a single long-running process — and it is deliberate: the matrix is read constantly
 * and written rarely, so a whole-document write per mutation is cheap and leaves no
 * room for a torn read.
 *
 * The narrow `cells` table is the part that matters for the eventual Postgres move:
 * one row per (module, subactivity, column), never a wide row per module, because
 * columns are user-configurable.
 */

export interface StoreData {
  version: number;
  tenants: Tenant[];
  users: UserWithSecret[];
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
  library: ModuleLibraryEntry[];
  defects: Defect[];
  links: Link[];
  runs: Run[];
  drift_rows: DriftRow[];
  drift_warnings: DriftWarning[];
}

/** 2: `cell_audit` became `audit`, carrying structural changes as well as cell changes. */
export const STORE_VERSION = 2;

function dataDir(): string {
  return process.env.TRACKER_DATA_DIR ?? path.join(process.cwd(), 'data');
}

function storePath(): string {
  return process.env.TRACKER_STORE_PATH ?? path.join(dataDir(), 'tracker.json');
}

let cache: StoreData | null = null;
/** Every write chains onto this, so two concurrent requests cannot interleave. */
let writeChain: Promise<void> = Promise.resolve();

function readFromDisk(): StoreData | null {
  const file = storePath();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as StoreData;
    if (parsed.version !== STORE_VERSION) {
      // A version bump means the seed shape changed under a store written by an older
      // build. Reseeding is right for a pilot; a migration list replaces this later.
      console.warn(
        `[store] on-disk version ${parsed.version} does not match ${STORE_VERSION} — reseeding`,
      );
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('[store] could not parse the store file, reseeding', error);
    return null;
  }
}

async function writeToDisk(data: StoreData): Promise<void> {
  const file = storePath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
  // Rename is atomic on the same volume, so a crash mid-write cannot truncate the store.
  await renameWithRetry(temporary, file);
}

/** Transient Windows failures: a scanner or an indexer holding the destination open
 *  for a moment makes rename-over-existing fail, and retrying clears it. Losing a
 *  write here would lose an audited status change, so it is worth waiting out. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (attempt >= attempts || !code || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
}

/**
 * Reads the store, seeding it on first use. Lazily imports the seed so the seed data
 * is not pulled into any bundle that only reads.
 */
export async function getStore(): Promise<StoreData> {
  if (cache) return cache;

  const onDisk = readFromDisk();
  if (onDisk) {
    cache = onDisk;
    return cache;
  }

  const { buildSeed } = await import('./seed');
  const seeded = await buildSeed();
  cache = seeded;
  await writeToDisk(seeded);
  return seeded;
}

/**
 * Applies a mutation and persists it. Mutations run one at a time and in order;
 * the callback receives the live document and may edit it in place.
 */
export async function mutate<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T> {
  const store = await getStore();

  const run = writeChain.then(async () => {
    const result = await fn(store);
    await writeToDisk(store);
    return result;
  });

  // Keep the chain alive even when this mutation rejects, or one failed write would
  // wedge every later one.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}

/** Test seam: drops the in-memory copy so the next read comes from disk (or reseeds). */
export function resetStoreCache(): void {
  cache = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}
