import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { StoreData } from '../store';
import { RevisionConflict, type StoreDriver, type StoredDocument } from './driver';

/**
 * The default driver: one JSON document on disk.
 *
 * Writes land via write-temp-then-rename, so a crash mid-write cannot truncate the store,
 * and the rename is retried on the transient Windows locks a sync client or an indexer
 * causes — losing a write here would lose an audited status change.
 *
 * **On concurrency, honestly:** this re-reads the revision on disk immediately before
 * writing and refuses if it moved, which catches a second process that wrote while a
 * mutation was being applied. It does not close the window between that check and the
 * rename, because doing so properly needs a lock file and a crash-recovery story for it.
 * For a pilot on one process that is the right trade; for more than one, use Postgres.
 */

const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (attempt >= attempts || !code || !TRANSIENT_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
}

export class FileDriver implements StoreDriver {
  readonly kind = 'file' as const;

  constructor(private readonly file: string) {}

  async read(): Promise<StoredDocument | null> {
    if (!fs.existsSync(this.file)) return null;
    try {
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8')) as StoreData;
      return { data, revision: data.revision ?? 0 };
    } catch (error) {
      console.error('[store] could not parse the store file, reseeding', error);
      return null;
    }
  }

  /** The revision as it stands on disk right now, for the pre-write check. */
  private currentRevision(): number | null {
    if (!fs.existsSync(this.file)) return null;
    try {
      return (JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoreData).revision ?? 0;
    } catch {
      return null;
    }
  }

  async write(data: StoreData, expectedRevision: number): Promise<number> {
    const onDisk = this.currentRevision();
    if (onDisk !== null && onDisk !== expectedRevision) {
      throw new RevisionConflict(expectedRevision, onDisk);
    }

    const revision = expectedRevision + 1;
    const document = { ...data, revision };

    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(document, null, 2), 'utf8');
    await renameWithRetry(temporary, this.file);

    // The caller holds this object; keep it in step with what was written.
    data.revision = revision;
    return revision;
  }
}
