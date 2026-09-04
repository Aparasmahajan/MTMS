import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { removeSubactivity, renameSubactivity } from '@/lib/server/service';

const Body = z.object({ name: z.string().trim().min(1) });

type Params = { id: string; subId: string };

export const PATCH = withAuth<Params>(async ({ actor, projectId, request, params, snapshot }) => {
  const body = await parseBody(request, Body);
  await renameSubactivity(actor, projectId, params.id, params.subId, body.name);
  return ok(await snapshot());
});

export const DELETE = withAuth<Params>(async ({ actor, projectId, params, snapshot }) => {
  await removeSubactivity(actor, projectId, params.id, params.subId);
  return ok(await snapshot());
});
