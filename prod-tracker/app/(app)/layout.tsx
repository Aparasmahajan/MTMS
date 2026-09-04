import { AppShell } from '@/components/AppShell';
import { TrackerProvider } from '@/components/TrackerProvider';
import { requireSnapshot } from '@/lib/server/session';

// Everything below reads the store per request; nothing here is safe to cache.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const snapshot = await requireSnapshot();

  return (
    <TrackerProvider initial={snapshot}>
      <AppShell>{children}</AppShell>
    </TrackerProvider>
  );
}
