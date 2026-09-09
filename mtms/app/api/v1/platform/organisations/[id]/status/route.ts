import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { buildPlatformView, setOrganisationStatus } from '@/lib/server/platform';
import { getStore } from '@/lib/server/store';

const Body = z.object({ status: z.enum(['active', 'suspended']) });

/**
 * Suspends or restores an organisation. Nothing is deleted and no project data is touched —
 * it is a gate on signing in, so an organisation can be stopped without losing its record.
 */
export const PATCH = withAuth<{ id: string }>(async ({ actor, request, params }) => {
  const body = await parseBody(request, Body);
  await setOrganisationStatus(actor, params.id, body.status);
  return ok(buildPlatformView(await getStore(), actor));
});
