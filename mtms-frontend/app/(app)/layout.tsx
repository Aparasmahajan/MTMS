import { AppShell } from '@/components/AppShell';
import { TrackerProvider } from '@/components/TrackerProvider';
import { requireSnapshot } from '@/lib/client/session';

/**
 * `requireSnapshot` reads the session cookie, which already marks every page under this
 * layout as dynamic — there is no `force-dynamic` here on purpose. A snapshot is per-user
 * and per-project, so caching one at the edge would serve one person's view to another.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const snapshot = await requireSnapshot();

  return (
    <TrackerProvider initial={snapshot}>
      <AppShell>{children}</AppShell>
    </TrackerProvider>
  );
}
