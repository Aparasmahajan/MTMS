'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, send } from '@/lib/client/api';
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
  /** Where a module's detail page lives. Always a real route here — every page is dynamic. */
  moduleHref: (id: string) => string;
  signOut: () => Promise<void>;
  /**
   * Always false in this build.
   *
   * Kept on the context because several screens branch on it to show the demo's role
   * switcher and reset button. This repository talks to a real service, so those controls
   * stay hidden — the two below are the inert half of that same pair, and they are here so
   * the screens compile unchanged against both this provider and the one in `mtms-static`.
   */
  isDemo: boolean;
  switchRole: (roleId: string) => void;
  resetToSeed: () => void;
}

const TrackerContext = createContext<TrackerContextValue | null>(null);

export function TrackerProvider({ initial, children }: { initial: Snapshot; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  // Mutations queue rather than race: the server serialises writes anyway, and two
  // optimistic updates applied out of order would show a value neither request made.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

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
    // Logging out is the service's job: it revokes the whole refresh-token family, so
    // every session started from that login ends, not just this tab. Failure is ignored —
    // the cookies are cleared server-side either way and the user wants to leave.
    await send('/api/v1/auth/logout', 'POST').catch(() => undefined);
    router.push('/login');
    router.refresh();
  }, [router]);

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
      moduleHref: (id) => `/modules/${id}`,
      signOut,
      isDemo: false,
      switchRole: () => undefined,
      resetToSeed: () => undefined,
    };
  }, [snapshot, pending, error, notice, apply, signOut]);

  return <TrackerContext.Provider value={value}>{children}</TrackerContext.Provider>;
}

export function useTracker(): TrackerContextValue {
  const context = useContext(TrackerContext);
  if (!context) throw new Error('useTracker must be used inside a TrackerProvider');
  return context;
}
