import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { inviteUser } from '@/lib/server/service';

const Body = z.object({
  email: z.string().trim().min(1),
  display_name: z.string().default(''),
  role_id: z.string().uuid(),
  /** null = organisation-wide, otherwise a named project. */
  scope_project_id: z.string().uuid().nullable().default(null),
});

/**
 * There is no mail transport in this release, so the acceptance link comes back in the
 * response for an admin to pass on. A Kafka `user.invited` event replaces this.
 */
export const POST = withAuth(async ({ actor, projectId, request, snapshot }) => {
  const body = await parseBody(request, Body);
  const { inviteToken } = await inviteUser(actor, projectId, {
    email: body.email,
    displayName: body.display_name,
    roleId: body.role_id,
    scopeProjectId: body.scope_project_id,
  });
  return ok(await snapshot(), { accept_url: `/accept-invite?token=${inviteToken}` });
});
