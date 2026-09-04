import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { deliver, invitationMessage } from '@/lib/server/mailer';
import { inviteUser } from '@/lib/server/service';

const Body = z.object({
  email: z.string().trim().min(1),
  display_name: z.string().default(''),
  role_id: z.string().uuid(),
  /** null = organisation-wide, otherwise a named project. */
  scope_project_id: z.string().uuid().nullable().default(null),
});

/**
 * The invitation is committed before delivery is attempted, and a delivery failure never
 * fails the request: the account and its single-use link already exist, so reporting
 * "the invitation failed" would be untrue. The acceptance link comes back either way so
 * an admin can pass it on — which is still the only route that works out of the box,
 * because no mail transport is configured by default. See `lib/server/mailer.ts`.
 */
export const POST = withAuth(async ({ actor, projectId, request, snapshot }) => {
  const body = await parseBody(request, Body);
  const { inviteToken, email } = await inviteUser(actor, projectId, {
    email: body.email,
    displayName: body.display_name,
    roleId: body.role_id,
    scopeProjectId: body.scope_project_id,
  });

  const acceptPath = `/accept-invite?token=${inviteToken}`;
  const acceptUrl = new URL(acceptPath, request.nextUrl.origin).toString();
  const projection = await snapshot();

  const delivery = await deliver(
    invitationMessage({
      email,
      displayName: body.display_name,
      invitedBy: actor.displayName,
      orgName: projection.org.name,
      acceptUrl,
    }),
  );

  return ok(projection, {
    accept_url: acceptPath,
    delivery_state: delivery.state,
    delivery_detail: delivery.detail,
  });
});
