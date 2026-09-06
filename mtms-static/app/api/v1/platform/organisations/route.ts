import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { buildPlatformView, createOrganisation } from '@/lib/server/platform';
import { getStore } from '@/lib/server/store';

/**
 * The platform level: organisations and their first admins.
 *
 * These routes sit outside project scope on purpose. `withAuth` resolves a project for the
 * caller as usual, and nothing here uses it — a super admin creating an organisation has
 * no current project, and must not need one.
 */

const Body = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().optional(),
  admin_email: z.string().trim().min(1),
  admin_name: z.string().trim().optional(),
});

export const GET = withAuth(async ({ actor }) => ok(buildPlatformView(await getStore(), actor)));

export const POST = withAuth(async ({ actor, request }) => {
  const body = await parseBody(request, Body);
  const result = await createOrganisation(actor, {
    name: body.name,
    slug: body.slug,
    adminEmail: body.admin_email,
    adminName: body.admin_name,
  });

  // No mail transport yet, so the acceptance link comes back for the operator to pass on.
  return ok(buildPlatformView(await getStore(), actor), {
    tenant_id: result.tenant.id,
    admin_email: result.adminEmail,
    accept_url: `/accept-invite?token=${result.inviteToken}`,
  });
});
