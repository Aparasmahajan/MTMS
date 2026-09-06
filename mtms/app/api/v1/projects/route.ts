import { z } from 'zod';
import { ok, parseBody, PROJECT_COOKIE, withAuth } from '@/lib/server/api';
import { createProject } from '@/lib/server/service';

const Body = z.object({
  key: z.string().trim().min(2),
  name: z.string().trim().default(''),
  description: z.string().trim().default(''),
});

/**
 * The new project becomes the one selected, because the only useful next step is to go
 * and configure it — and the snapshot returned is already the new project's.
 */
export const POST = withAuth(async ({ actor, projectId, request }) => {
  const body = await parseBody(request, Body);
  const { projectId: created } = await createProject(actor, projectId, {
    key: body.key,
    name: body.name,
    description: body.description,
  });

  const { buildSnapshot } = await import('@/lib/server/service');
  const { getStore } = await import('@/lib/server/store');
  const response = ok(buildSnapshot(await getStore(), actor, created), { project_id: created });
  response.cookies.set(PROJECT_COOKIE, created, { path: '/', sameSite: 'lax' });
  return response;
});
