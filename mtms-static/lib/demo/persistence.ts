import type { Snapshot } from '@/lib/shared/views';

/**
 * Making the static build's edits survive, and appear in other tabs.
 *
 * There is no server here. That fixes the ceiling of what this file can do, and it is worth
 * being exact about where the ceiling is rather than implying more:
 *
 * - **Edits persist.** The whole snapshot is written to `localStorage` after every mutation,
 *   so a reload — or closing the laptop and opening it tomorrow — shows the work, not the
 *   seed.
 * - **Other tabs update live.** A `BroadcastChannel` carries the new snapshot to every other
 *   tab of the same browser, and they re-render immediately. Two windows side by side stay
 *   in step.
 * - **Another person does not see any of it.** `localStorage` is per browser, per origin.
 *   Two people on two machines have two separate stores and no channel between them. That
 *   is not a limitation of this implementation; it is what "no backend" means. Sharing
 *   across people needs the Spring service in `mtms-backend`.
 *
 * The `storage` event is kept as a fallback for browsers without `BroadcastChannel`. It
 * fires only in *other* tabs, which is exactly the semantics wanted, and it is why the
 * channel message and the storage event can both be handled without double-applying.
 */

/**
 * Versioned. A snapshot written by an older build may not have the fields this one reads,
 * and showing a half-populated screen is worse than starting from the seed — so the key
 * changes when the shape does, and the old value is simply never read again.
 */
const STORAGE_KEY = 'mtms.static.snapshot.v1';
const CHANNEL_NAME = 'mtms.static.snapshot';

type Listener = (snapshot: Snapshot) => void;

let channel: BroadcastChannel | null = null;
const listeners = new Set<Listener>();

/** Server-side rendering runs this module during the export; there is no window there. */
function browser(): boolean {
  return typeof window !== 'undefined';
}

function openChannel(): BroadcastChannel | null {
  if (!browser() || typeof BroadcastChannel === 'undefined') return null;
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** The snapshot this browser last saved, or null to start from the baked seed. */
export function loadSnapshot(): Snapshot | null {
  if (!browser()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  } catch {
    // Private browsing, a full quota, or a value some other tool wrote over ours. None of
    // these are worth failing a demo over — fall back to the seed.
    return null;
  }
}

/**
 * Persists and announces a change.
 *
 * Both halves are best-effort. If storage is unavailable the demo still works for the life
 * of the tab, which is strictly better than refusing to accept the edit.
 */
export function saveSnapshot(snapshot: Snapshot): void {
  if (!browser()) return;

  const serialised = JSON.stringify(snapshot);
  try {
    window.localStorage.setItem(STORAGE_KEY, serialised);
  } catch {
    // Quota exceeded is the realistic one. A snapshot is a few hundred kilobytes and the
    // limit is around five megabytes, so this needs another tool to have filled the origin.
  }

  try {
    openChannel()?.postMessage(serialised);
  } catch {
    // A channel closed by a navigating tab. The storage event still reaches the others.
  }
}

/** Forgets everything, in every tab. Used by the demo's reset control. */
export function clearSnapshot(): void {
  if (!browser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing useful to do */
  }
  try {
    openChannel()?.postMessage(null);
  } catch {
    /* nothing useful to do */
  }
}

/**
 * Watches for changes made in other tabs.
 *
 * Returns an unsubscribe function, which React's effect cleanup needs — without it a
 * remounting provider would stack listeners and apply every update several times.
 */
export function subscribeToRemoteChanges(listener: Listener): () => void {
  if (!browser()) return () => undefined;

  listeners.add(listener);

  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return; // a reset; the sender reloads its own state
    try {
      const snapshot = JSON.parse(event.data) as Snapshot;
      listeners.forEach((notify) => notify(snapshot));
    } catch {
      /* a message we cannot read is one we ignore */
    }
  };

  const onStorage = (event: StorageEvent) => {
    // Fires only in other tabs, and only for this key. `newValue` is null on removal.
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const snapshot = JSON.parse(event.newValue) as Snapshot;
      listeners.forEach((notify) => notify(snapshot));
    } catch {
      /* likewise */
    }
  };

  const openedChannel = openChannel();
  openedChannel?.addEventListener('message', onMessage);
  window.addEventListener('storage', onStorage);

  return () => {
    listeners.delete(listener);
    openedChannel?.removeEventListener('message', onMessage);
    window.removeEventListener('storage', onStorage);
  };
}
