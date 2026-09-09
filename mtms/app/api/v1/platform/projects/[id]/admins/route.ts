import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { addProjectAdmin, buildPlatformView } from '@/lib/server/platform';
import { getStore } from '@/lib/server/store';

const Body = z.object({
  email: z.string().trim().email(),
  display_name: z.string().trim().optional(),
});

/**
 * Gives someone administrator access to one project, inviting them if they are new.
 *
 * The acceptance link comes back in `meta` when a new person was invited. There is no mail
 * transport yet, so the console surfaces the link for an operator to pass on by hand — the
 * account and its single-use token already exist by then either way.
 */
export const POST = withAuth<{ id: string }>(async ({ actor, request, params }) => {
  const body = await parseBody(request, Body);
  const result = await addProjectAdmin(actor, params.id, {
    email: body.email,
    displayName: body.display_name,
  });

  // Snake_case literals, not camelCase. Jackson-style renaming is not in play here, but
  // the frontend reads these keys as written, so they are written as it reads them.
  return ok(buildPlatformView(await getStore(), actor), {
    admin_email: result.email,
    project_key: result.projectKey,
    invited: result.invited,
    accept_url: result.inviteToken ? `/accept-invite?token=${result.inviteToken}` : null,
  });
});
