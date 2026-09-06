import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { addProjectMember } from '@/lib/server/service';

const Body = z.object({
  user_id: z.string().uuid(),
  role_id: z.string().uuid(),
});

export const POST = withAuth(async ({ actor, projectId, request, snapshot }) => {
  const body = await parseBody(request, Body);
  await addProjectMember(actor, projectId, { userId: body.user_id, roleId: body.role_id });
  return ok(await snapshot());
});
