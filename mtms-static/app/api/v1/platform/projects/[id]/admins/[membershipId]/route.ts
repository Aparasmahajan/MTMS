import { ok, withAuth } from '@/lib/server/api';
import { buildPlatformView, removeProjectAdmin } from '@/lib/server/platform';
import { getStore } from '@/lib/server/store';

/**
 * Takes one administrator's access to one project away.
 *
 * Addressed by membership id rather than by user: a person can hold access to several
 * projects, and only the row that was clicked on should go.
 */
export const DELETE = withAuth<{ id: string; membershipId: string }>(
  async ({ actor, params }) => {
    await removeProjectAdmin(actor, params.id, params.membershipId);
    return ok(buildPlatformView(await getStore(), actor));
  },
);
