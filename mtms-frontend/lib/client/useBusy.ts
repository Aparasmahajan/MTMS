'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * One submission at a time, for a form that creates something.
 *
 * The create forms cleared their inputs only after the request succeeded, and nothing stopped a
 * second click in between — so a double-click on "Add defect" logged two defects, and the same
 * for invitations, topics, columns and projects. The ref, not the state, is what refuses the
 * second call: two clicks in the same frame both see the state from before the first render.
 */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  return [busy, run] as const;
}
