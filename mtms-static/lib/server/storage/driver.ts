import type { StoreData } from '../store';

/**
 * The storage seam.
 *
 * The store is one JSON document. What differs between deployments is *where* it lives and
 * how two writers are kept from clobbering each other — so that, and only that, is what a
 * driver implements.
 *
 * Concurrency is optimistic. Every read carries the revision it saw; every write states the
 * revision it expects to replace. A driver must refuse a write whose expected revision is no
 * longer current, by throwing `RevisionConflict`. `mutate()` in `store.ts` then re-reads and
 * re-applies the change against fresh data.
 *
 * That is the whole contract. A driver never interprets the document.
 */

export interface StoredDocument {
  data: StoreData;
  /** Monotonic. Incremented by the driver on every successful write. */
  revision: number;
}

export interface StoreDriver {
  /** The name that appears in logs and in the storage banner. */
  readonly kind: 'file' | 'postgres';

  /** Returns null when nothing has been stored yet, which is the signal to seed. */
  read(): Promise<StoredDocument | null>;

  /**
   * Persists the document, but only if `expectedRevision` is still current.
   * Returns the new revision. Throws `RevisionConflict` if it is not.
   */
  write(data: StoreData, expectedRevision: number): Promise<number>;

  /** Optional: release a pool or a handle. Called by tests, not by the app. */
  close?(): Promise<void>;
}

/**
 * Thrown when someone else wrote first. Not an error the user ever sees — `mutate()`
 * catches it, re-reads and re-runs the mutation, so the change lands on top of theirs
 * rather than over it.
 */
export class RevisionConflict extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`The store moved on: expected revision ${expected}, found ${actual}.`);
    this.name = 'RevisionConflict';
  }
}
