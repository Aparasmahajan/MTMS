import { DemoBoot } from '@/components/DemoBoot';
import { IS_DEMO } from '@/lib/demo/config';
import { buildDemoSnapshot } from '@/lib/server/demo-snapshot';

/**
 * The super admin console sits outside the project shell, so nothing had started the
 * demo runtime for it — `TrackerProvider` does that, and it only wraps `(app)`.
 *
 * Only the demo needs this. With a real server the console fetches over HTTP like any
 * other page, and building a project snapshot here would be work nobody reads — worse,
 * it would demand a current project, which a platform operator may not have.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  if (!IS_DEMO) return <>{children}</>;

  const snapshot = await buildDemoSnapshot();
  return <DemoBoot initial={snapshot}>{children}</DemoBoot>;
}
