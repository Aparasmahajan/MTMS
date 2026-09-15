'use client';

import { useEffect, useState } from 'react';
import { IS_DEMO } from '@/lib/demo/config';
import { adoptSnapshot, initDemoRuntime } from '@/lib/demo/runtime';
import { loadSnapshot } from '@/lib/demo/persistence';
import type { Snapshot } from '@/lib/shared/views';

/**
 * Starts the demo runtime for a screen that lives outside the project shell.
 *
 * `TrackerProvider` does this for every screen under `(app)`, but the super admin console
 * is deliberately not under it — it has no project, and giving it the project chrome would
 * suggest a platform operator is *in* an organisation when the whole point is that they
 * are not. Landing straight on `/platform` therefore reached a runtime nobody had started.
 *
 * Initialising during render rather than in an effect is deliberate: the console fetches
 * its data from the first effect it runs, and an effect here would not have happened yet.
 */
export function DemoBoot({
  initial,
  children,
}: {
  initial: Snapshot;
  children: React.ReactNode;
}) {
  if (IS_DEMO) initDemoRuntime(initial);

  // Whatever this browser saved wins over the baked seed, so a project created on the
  // console and then edited in the app is the one the console shows on the way back.
  const [ready, setReady] = useState(!IS_DEMO);
  useEffect(() => {
    if (!IS_DEMO) return;
    const saved = loadSnapshot();
    if (saved) adoptSnapshot(saved);
    setReady(true);
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}
