import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { buildPlatformView, createOrganisationProject } from '@/lib/server/platform';
import { getStore } from '@/lib/server/store';

const Body = z.object({
  key: z.string().trim().min(2),
  name: z.string().trim().optional(),
  description: z.string().trim().optional(),
});

/**
 * Creates an empty project inside an organisation.
 *
 * Empty is deliberate: no columns, no node types, no stages. The team that owns it defines
 * its own process on the Configure screen — a platform operator pre-filling it would be
 * deciding another team's process for them.
 */
export const POST = withAuth<{ id: string }>(async ({ actor, request, params }) => {
  const body = await parseBody(request, Body);
  const result = await createOrganisationProject(actor, params.id, body);

  return ok(buildPlatformView(await getStore(), actor), {
    project_id: result.projectId,
    key: result.key,
  });
});
