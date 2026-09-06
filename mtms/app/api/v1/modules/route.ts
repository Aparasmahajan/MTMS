import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { createModule } from '@/lib/server/service';

const Body = z.object({
  node_type: z.string().trim().min(1),
  name: z.string().trim().min(1),
  /** Catalogue it for other projects to clone. The exception, not the default. */
  add_to_library: z.boolean().default(false),
});

export const POST = withAuth(async ({ actor, projectId, request, snapshot }) => {
  const body = await parseBody(request, Body);
  const { moduleId } = await createModule(actor, projectId, {
    nodeType: body.node_type,
    name: body.name,
    addToLibrary: body.add_to_library,
  });
  return ok(await snapshot(), { module_id: moduleId });
});
