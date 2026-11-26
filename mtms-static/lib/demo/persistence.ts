import type { DemoWorkspace } from '@/lib/demo/workspace';
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
// Bumped when the shape or the vocabulary changes: a returning visitor holds a snapshot
// whose columns carry the OLD allowed sets, and would never be offered preprod.
//
// v4: the rename that brought this app level with `mtms-frontend` — `modules` became
// `sub_modules`, a sub-module gained `step_lists`, `owners` and `threads`, and the snapshot
// gained the step library, the inbox and both timing panels. A v3 snapshot has none of
// those and the old name for the one it does have, so loading it would render every screen
// half-empty. That port missed this bump; it is the exact failure this key exists to stop.
//
// Exported so the e2e spec reads this rather than its own copy. It held a copy, and the copy
// stayed at v1 through two bumps — so a test asserting on what is stored was reading a key
// nothing has written to since September.
export const STORAGE_KEY = 'mtms.static.snapshot.v4';
/**
 * Everything above one project — the other projects' snapshots, and the organisations and
 * administrators the super admin console reads. A second key rather than one combined
 * value so the snapshot slot keeps its shape: the provider and the cross-tab channel both
 * carry a `Snapshot` and neither needs to learn about the workspace.
 */
// v2: same reason as the v4 above. The workspace holds a snapshot per project, so every one
// of them carries the old shape too — bumping only the current-project key would leave the
// others to load half-empty the moment somebody switched project.
export const WORKSPACE_KEY = 'mtms.static.workspace.v2';
/**
 * Versioned with the keys, from the same string, so it cannot be left behind by a bump. A tab
 * still running the previous build would otherwise post the previous shape into this one —
 * and adopting it is exactly the half-empty render the key bump exists to prevent.
 */
const CHANNEL_NAME = `${STORAGE_KEY}:channel`;

/**
 * Everything this app has ever stored starts with this. Anything under it that is not one of
 * the two current keys is a previous version's — never read again, and a few hundred
 * kilobytes each of a quota the current snapshot needs.
 */
const KEY_PREFIX = 'mtms.static.';

/** What crosses the channel. Tagged, so a reset and a workspace are never mistaken for a snapshot. */
type ChannelMessage =
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'workspace'; workspace: DemoWorkspace }
  | { kind: 'reset' };

export interface RemoteListeners {
  /** Another tab saved a snapshot. */
  snapshot: (snapshot: Snapshot) => void;
  /** Another tab changed the workspace — a new project or organisation, typically. */
  workspace?: (workspace: DemoWorkspace) => void;
  /** Another tab pressed Reset. */
  reset?: () => void;
}

let channel: BroadcastChannel | null = null;

/** Server-side rendering runs this module during the export; there is no window there. */
function browser(): boolean {
  return typeof window !== 'undefined';
}

function openChannel(): BroadcastChannel | null {
  if (!browser() || typeof BroadcastChannel === 'undefined') return null;
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

// ---------------------------------------------------------------------------
// Shape checks
// ---------------------------------------------------------------------------
//
// Whatever arrives from storage or from another tab is untrusted in the narrow sense that it
// may have been written by a different build. These check the fields this build cannot render
// without; they are not a schema, and do not need to be — the version in the key and the
// channel name does the rest.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSnapshotShape(value: unknown): value is Snapshot {
  if (!isRecord(value)) return false;
  const { project, me, config } = value;
  if (!isRecord(project) || typeof project.id !== 'string') return false;
  if (!isRecord(me) || !Array.isArray(me.permissions)) return false;
  if (!isRecord(config) || !Array.isArray(config.columns) || !Array.isArray(config.modules)) {
    return false;
  }
  for (const field of [
    'sub_modules',
    'audit',
    'roles',
    'projects',
    'step_library',
    'notifications',
    'timing',
    'step_timing',
  ]) {
    if (!Array.isArray(value[field])) return false;
  }
  // The v4 rename — a sub-module without these is the old shape under a new key.
  return (value.sub_modules as unknown[]).every(
    (row) => isRecord(row) && Array.isArray(row.step_lists) && Array.isArray(row.sub_activities),
  );
}

export function isWorkspaceShape(value: unknown): value is DemoWorkspace {
  if (!isRecord(value)) return false;
  if (typeof value.current_project_id !== 'string') return false;
  if (!isRecord(value.snapshots) || !Array.isArray(value.organisations)) return false;
  if (!isRecord(value.project_admins) || !Array.isArray(value.audit)) return false;
  return Object.values(value.snapshots).every(isSnapshotShape);
}

function parseMessage(data: unknown): ChannelMessage | null {
  if (!isRecord(data)) return null;
  if (data.kind === 'reset') return { kind: 'reset' };
  if (data.kind === 'snapshot' && isSnapshotShape(data.snapshot)) {
    return { kind: 'snapshot', snapshot: data.snapshot };
  }
  if (data.kind === 'workspace' && isWorkspaceShape(data.workspace)) {
    return { kind: 'workspace', workspace: data.workspace };
  }
  return null;
}

function readJson(key: string): unknown {
  const raw = window.localStorage.getItem(key);
  return raw ? (JSON.parse(raw) as unknown) : null;
}

function post(message: ChannelMessage): void {
  try {
    openChannel()?.postMessage(message);
  } catch {
    // A channel closed by a navigating tab. The storage event still reaches the others.
  }
}

// ---------------------------------------------------------------------------
// Failing to persist
// ---------------------------------------------------------------------------

type FailureListener = (message: string) => void;
const failureListeners = new Set<FailureListener>();

/**
 * Hears about a write that did not persist. The provider shows it as a notice.
 *
 * Silently keeping an edit in memory and losing it on reload is the one failure here worth
 * telling somebody about: they would reasonably believe the work was saved.
 */
export function onPersistFailure(listener: FailureListener): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22)
  );
}

function write(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    const message = isQuotaError(error)
      ? 'This browser’s storage for the demo is full, so your last change is showing here but was not saved — it will be gone after a reload. Use “Reset demo” to clear the saved state and free the space.'
      : 'This browser would not let the demo save (private browsing, or storage switched off). Your changes work in this tab but will be gone after a reload.';
    failureListeners.forEach((notify) => notify(message));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Removes what earlier builds stored — `mtms.static.snapshot.v1`–`v3`, `workspace.v1` and
 * anything else under the prefix that is not a current key.
 *
 * Called once on start. A returning visitor otherwise carries every previous version's
 * snapshot forever, and three dead copies are most of the way to the quota.
 */
export function purgeStaleKeys(): void {
  if (!browser()) return;
  try {
    const stale: string[] = [];
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(KEY_PREFIX) && key !== STORAGE_KEY && key !== WORKSPACE_KEY) {
        stale.push(key);
      }
    }
    stale.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    /* storage unavailable — nothing to clean */
  }
}

/** The snapshot this browser last saved, or null to start from the baked seed. */
export function loadSnapshot(): Snapshot | null {
  if (!browser()) return null;
  try {
    const value = readJson(STORAGE_KEY);
    // A value of the wrong shape is treated as absent: showing a half-populated screen is
    // worse than starting from the seed.
    return isSnapshotShape(value) ? value : null;
  } catch {
    // Private browsing, or a value some other tool wrote over ours. Neither is worth failing
    // a demo over — fall back to the seed.
    return null;
  }
}

/**
 * Persists and announces a change.
 *
 * If storage refuses, the demo still works for the life of the tab and the failure listeners
 * are told, so the person is warned rather than finding out on the next reload.
 */
export function saveSnapshot(snapshot: Snapshot): boolean {
  if (!browser()) return true;
  const saved = write(STORAGE_KEY, JSON.stringify(snapshot));
  post({ kind: 'snapshot', snapshot });
  return saved;
}

/** The workspace this browser last saved, or null to build one from the baked seed. */
export function loadWorkspace(): DemoWorkspace | null {
  if (!browser()) return null;
  try {
    const value = readJson(WORKSPACE_KEY);
    return isWorkspaceShape(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Persists the workspace, and tells the other tabs.
 *
 * Broadcast because a tab that never heard about a project created next door would carry
 * its own older workspace and write it back on its next edit — deleting the new project.
 * The runtime also re-reads the stored workspace before every write, which covers a tab
 * whose channel message has not arrived yet.
 */
export function saveWorkspace(workspace: DemoWorkspace): boolean {
  if (!browser()) return true;
  const saved = write(WORKSPACE_KEY, JSON.stringify(workspace));
  post({ kind: 'workspace', workspace });
  return saved;
}

/** Forgets everything, in every tab. Used by the demo's reset control. */
export function clearSnapshot(): void {
  if (!browser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    /* nothing useful to do */
  }
  post({ kind: 'reset' });
}

/**
 * Watches for changes made in other tabs.
 *
 * Returns an unsubscribe function, which React's effect cleanup needs — without it a
 * remounting provider would stack listeners and apply every update several times.
 *
 * Both the channel and the `storage` event are listened to, because the storage event is the
 * fallback for a browser without `BroadcastChannel`. Where both fire the update is applied
 * twice, which is harmless: adopting the same snapshot again changes nothing.
 */
export function subscribeToRemoteChanges(listeners: RemoteListeners): () => void {
  if (!browser()) return () => undefined;

  const deliver = (message: ChannelMessage | null) => {
    if (!message) return; // a different build's message, or something we cannot read
    if (message.kind === 'snapshot') listeners.snapshot(message.snapshot);
    else if (message.kind === 'workspace') listeners.workspace?.(message.workspace);
    else listeners.reset?.();
  };

  const onMessage = (event: MessageEvent) => deliver(parseMessage(event.data));

  const onStorage = (event: StorageEvent) => {
    // Fires only in other tabs. `newValue` is null on removal, which only a reset does.
    try {
      if (event.key === STORAGE_KEY) {
        if (event.newValue === null) deliver({ kind: 'reset' });
        else deliver(parseMessage({ kind: 'snapshot', snapshot: JSON.parse(event.newValue) }));
      } else if (event.key === WORKSPACE_KEY && event.newValue !== null) {
        deliver(parseMessage({ kind: 'workspace', workspace: JSON.parse(event.newValue) }));
      } else if (event.key === null) {
        // `localStorage.clear()` from somewhere — everything is gone, which is a reset.
        deliver({ kind: 'reset' });
      }
    } catch {
      /* a value we cannot read is one we ignore */
    }
  };

  const openedChannel = openChannel();
  openedChannel?.addEventListener('message', onMessage);
  window.addEventListener('storage', onStorage);

  return () => {
    openedChannel?.removeEventListener('message', onMessage);
    window.removeEventListener('storage', onStorage);
  };
}
