import { AppShell } from '@/components/AppShell';
import { TrackerProvider } from '@/components/TrackerProvider';
import { IS_DEMO } from '@/lib/demo/config';
import { buildDemoSnapshot } from '@/lib/server/demo-snapshot';
import { requireSnapshot } from '@/lib/server/session';

/**
 * `requireSnapshot` reads the session cookie, which already marks every page under this
 * layout as dynamic — there is no `force-dynamic` here on purpose. The demo build takes
 * the other branch, touches no cookie, and so can be prerendered to static HTML.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const snapshot = IS_DEMO ? await buildDemoSnapshot() : await requireSnapshot();

  return (
    <TrackerProvider initial={snapshot}>
      <AppShell>{children}</AppShell>
    </TrackerProvider>
  );
}
