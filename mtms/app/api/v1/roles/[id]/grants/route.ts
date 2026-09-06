import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { toggleGrant } from '@/lib/server/service';

const Body = z.object({ permission: z.string().min(1), granted: z.boolean() });

/** Clicking a cell in the Access grid. Nobody can grant a permission they lack. */
export const PATCH = withAuth<{ id: string }>(async ({ actor, projectId, request, params, snapshot }) => {
  const body = await parseBody(request, Body);
  await toggleGrant(actor, projectId, params.id, body.permission, body.granted);
  return ok(await snapshot());
});
