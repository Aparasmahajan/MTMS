import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { addSubactivity } from '@/lib/server/service';

const Body = z.object({ name: z.string().trim().min(1) });

export const POST = withAuth<{ id: string }>(async ({ actor, projectId, request, params, snapshot }) => {
  const body = await parseBody(request, Body);
  const { subactivityId } = await addSubactivity(actor, projectId, params.id, body.name);
  return ok(await snapshot(), { subactivity_id: subactivityId });
});
