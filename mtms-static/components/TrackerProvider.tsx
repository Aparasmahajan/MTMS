'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, send } from '@/lib/client/api';
import { IS_DEMO } from '@/lib/demo/config';
import { adoptSnapshot, initDemoRuntime, resetDemo, switchDemoRole } from '@/lib/demo/runtime';
import { loadSnapshot, subscribeToRemoteChanges } from '@/lib/demo/persistence';
import { hasPermission, permissionDeniedReason, type PermissionKey } from '@/lib/shared/permissions';
import type { ModuleView, Snapshot } from '@/lib/shared/views';

/**
 * One snapshot of the project, held client-side, with optimistic mutation.
 *
 * A cell click has to feel instantaneous, so `apply` renders the expected result at
 * once and reconciles with the server's projection when it lands. If the server refuses
 * — a roll-up cell, a missing permission, a closed module — the optimistic state is
 * rolled back and the server's own message is shown. The client never decides whether
 * a change is allowed; it only guesses what the result will look like.
 */

interface TrackerContextValue {
  snapshot: Snapshot;
  /** Set while a mutation is in flight, for the "saving" hint. */
  pending: boolean;
  error: string | null;
  clearError: () => void;
  notice: string | null;
  setNotice: (message: string | null) => void;
  apply: (
    optimistic: ((current: Snapshot) => Snapshot) | null,
    call: () => Promise<{ data: Snapshot; meta: Record<string, unknown> }>,
  ) => Promise<Record<string, unknown> | null>;
  can: (key: PermissionKey) => boolean;
  /** The message a disabled control shows. Never let one fail silently. */
  reasonFor: (key: PermissionKey) => string;
  moduleById: (id: string) => ModuleView | undefined;
  /**
   * Where a module's detail page lives. In the static demo only the seeded modules have
   * prerendered HTML, so one created during the tour falls back to the matrix rather
   * than to a 404 on the client's static host.
   */
  moduleHref: (id: string) => string;
  signOut: () => Promise<void>;
  /** True in the static client demo: no server, nothing persists. */
  isDemo: boolean;
  /** Demo only — swaps the permission set so the gating can be shown to a client. */
  switchRole: (roleId: string) => void;
  /** Demo only — puts everything back to the seeded state. */
  resetToSeed: () => void;
}

const TrackerContext = createContext<TrackerContextValue | null>(null);

export function TrackerProvider({ initial, children }: { initial: Snapshot; children: ReactNode }) {
  // The demo's in-browser store is seeded from the prerendered projection, once, before
  // anything can mutate it. Idempotent, so a client-side navigation does not reset it.
  if (IS_DEMO) initDemoRuntime(initial);

  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  // Mutations queue rather than race: the server serialises writes anyway, and two
  // optimistic updates applied out of order would show a value neither request made.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * Edits made in another tab of this browser arrive here and are rendered immediately.
   *
   * `adoptSnapshot` is not optional. Rendering the incoming state while the runtime still
   * held this tab's older copy would mean the next click was applied to the stale one,
   * quietly reverting whatever the other tab just did.
   *
   * This is the whole of the cross-viewer story in a static build: same browser, live;
   * another person, not at all. There is no server to carry it further.
   */
  useEffect(() => {
    if (!IS_DEMO) return undefined;

    /*
     * Render whatever this browser saved earlier.
     *
     * The runtime already prefers it — `initDemoRuntime` reads storage — but React state was
     * initialised from `initial`, which is the seed baked into the prerendered HTML. Without
     * this the first paint after a reload shows the seed while the store holds the edits, and
     * the two only converge on the next mutation.
     *
     * It has to happen *after* mount rather than during render: the server-rendered markup is
     * the seed, and returning anything else on the first pass is a hydration mismatch.
     */
    const saved = loadSnapshot();
    if (saved) {
      adoptSnapshot(saved);
      setSnapshot(saved);
    }

    return subscribeToRemoteChanges((incoming) => {
      adoptSnapshot(incoming);
      setSnapshot(incoming);
    });
  }, []);

  /** Which module pages exist as static HTML — see `moduleHref`. */
  const prerendered = useRef<Set<string>>(new Set(initial.modules.map((module) => module.id)));

  const apply = useCallback<TrackerContextValue['apply']>((optimistic, call) => {
    const run = queue.current.then(async () => {
      let rollback: Snapshot | null = null;
      if (optimistic) {
        setSnapshot((current) => {
          rollback = current;
          return optimistic(current);
        });
      }

      setPending(true);
      setError(null);
      try {
        const { data, meta } = await call();
        setSnapshot(data);
        return meta;
      } catch (caught) {
        if (rollback) setSnapshot(rollback);
        const message =
          caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.';
        setError(message);
        if (caught instanceof ApiError && caught.code === 'unauthenticated') {
          router.push('/login');
        }
        return null;
      } finally {
        setPending(false);
      }
    });

    queue.current = run.catch(() => undefined);
    return run;
  }, [router]);

  const signOut = useCallback(async () => {
    if (IS_DEMO) {
      // There is nothing to sign out of, and dropping a client on a login screen they
      // cannot get past would be a poor demo. Start the tour over instead.
      setSnapshot(resetDemo(initial));
      router.push('/');
      return;
    }
    await send('/api/v1/auth/logout', 'POST').catch(() => undefined);
    router.push('/login');
    router.refresh();
  }, [router, initial]);

  const switchRole = useCallback((roleId: string) => {
    setSnapshot(switchDemoRole(roleId));
  }, []);

  const resetToSeed = useCallback(() => {
    setSnapshot(resetDemo(initial));
  }, [initial]);

  const value = useMemo<TrackerContextValue>(() => {
    const permissions = new Set(snapshot.me.permissions);
    return {
      snapshot,
      pending,
      error,
      clearError: () => setError(null),
      notice,
      setNotice,
      apply,
      can: (key) => hasPermission(permissions, key),
      reasonFor: (key) => permissionDeniedReason(key),
      moduleById: (id) => snapshot.modules.find((module) => module.id === id),
      moduleHref: (id) =>
        !IS_DEMO || prerendered.current.has(id) ? `/modules/${id}` : '/matrix',
      signOut,
      isDemo: IS_DEMO,
      switchRole,
      resetToSeed,
    };
  }, [snapshot, pending, error, notice, apply, signOut, switchRole, resetToSeed]);

  return <TrackerContext.Provider value={value}>{children}</TrackerContext.Provider>;
}

export function useTracker(): TrackerContextValue {
  const context = useContext(TrackerContext);
  if (!context) throw new Error('useTracker must be used inside a TrackerProvider');
  return context;
}
