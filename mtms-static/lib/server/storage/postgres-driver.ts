import type { StoreData } from '../store';
import { RevisionConflict, type StoreDriver, type StoredDocument } from './driver';

/**
 * Postgres, holding the document in one row with a revision column.
 *
 * This is the staged move, and the staging is deliberate. It buys the property that
 * actually matters now — **two processes can no longer lose each other's writes** —
 * without rewriting every mutation, because a write is
 *
 *     UPDATE ... SET document = $doc, revision = $r + 1 WHERE id = $id AND revision = $r
 *
 * and a zero row count means somebody else got there first. `mutate()` re-reads and
 * re-applies rather than overwriting.
 *
 * What it does *not* buy is SQL over the data: the matrix is still assembled in Node, and
 * nothing else can query modules or cells. `schema.sql` in this directory is the relational
 * target for that, and entities can be ported behind this same seam one at a time.
 *
 * `pg` is loaded through a variable specifier so the bundler leaves it alone and the app
 * runs with the package absent — the file driver is the default and needs nothing.
 *
 * NOT YET RUN AGAINST A DATABASE. There is no Postgres on the development machine, so the
 * SQL below is unverified; see pending.md.
 */

interface QueryResult {
  rows: { revision: string | number; document: StoreData }[];
  rowCount: number | null;
}

interface PoolLike {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}

const DOCUMENT_ID = 'default';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS mtms_store (
    id         text PRIMARY KEY,
    revision   bigint NOT NULL,
    document   jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

export class PostgresDriver implements StoreDriver {
  readonly kind = 'postgres' as const;

  private pool: PoolLike | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly connectionString: string) {}

  private async connect(): Promise<PoolLike> {
    if (this.pool) return this.pool;

    // A variable specifier: the bundler cannot resolve it statically, so `pg` stays an
    // optional dependency that only a Postgres deployment has to install.
    const specifier = 'pg';
    let module: { Pool: new (config: { connectionString: string }) => PoolLike };
    try {
      module = (await import(/* @vite-ignore */ specifier)) as never;
    } catch {
      throw new Error(
        'DATABASE_URL is set but the `pg` package is not installed. Run `npm install pg`, or unset DATABASE_URL to use the file store.',
      );
    }

    this.pool = new module.Pool({ connectionString: this.connectionString });
    return this.pool;
  }

  /** Creates the table on first use. Idempotent, and cheap enough to await per call. */
  private async ensureTable(): Promise<void> {
    this.ready ??= (async () => {
      const pool = await this.connect();
      await pool.query(CREATE_TABLE);
    })();
    return this.ready;
  }

  async read(): Promise<StoredDocument | null> {
    await this.ensureTable();
    const pool = await this.connect();

    const result = await pool.query('SELECT revision, document FROM mtms_store WHERE id = $1', [
      DOCUMENT_ID,
    ]);
    const row = result.rows[0];
    if (!row) return null;

    // bigint comes back as a string from node-postgres; it is a counter, not money.
    return { data: row.document, revision: Number(row.revision) };
  }

  async write(data: StoreData, expectedRevision: number): Promise<number> {
    await this.ensureTable();
    const pool = await this.connect();

    const revision = expectedRevision + 1;
    const document = JSON.stringify({ ...data, revision });

    // First write of all: insert, and let a racing insert win rather than overwrite it.
    if (expectedRevision === 0) {
      const inserted = await pool.query(
        `INSERT INTO mtms_store (id, revision, document)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [DOCUMENT_ID, revision, document],
      );
      if (inserted.rowCount === 1) {
        data.revision = revision;
        return revision;
      }
      // Somebody seeded first. Fall through so the caller re-reads and re-applies.
    }

    const updated = await pool.query(
      `UPDATE mtms_store
          SET document = $3::jsonb, revision = $2, updated_at = now()
        WHERE id = $1 AND revision = $4`,
      [DOCUMENT_ID, revision, document, expectedRevision],
    );

    if (updated.rowCount !== 1) {
      const current = await pool.query('SELECT revision FROM mtms_store WHERE id = $1', [DOCUMENT_ID]);
      throw new RevisionConflict(expectedRevision, Number(current.rows[0]?.revision ?? -1));
    }

    data.revision = revision;
    return revision;
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
    this.ready = null;
  }
}
