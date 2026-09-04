import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { removeProjectMember, setMemberRole } from '@/lib/server/service';

const Body = z.object({ role_id: z.string().uuid() });

export const PATCH = withAuth<{ id: string }>(async ({ actor, projectId, request, params, snapshot }) => {
  const body = await parseBody(request, Body);
  await setMemberRole(actor, projectId, params.id, body.role_id);
  return ok(await snapshot());
});

export const DELETE = withAuth<{ id: string }>(async ({ actor, projectId, params, snapshot }) => {
  await removeProjectMember(actor, projectId, params.id);
  return ok(await snapshot());
});
