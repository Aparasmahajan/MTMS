import { ok, withAuth } from '@/lib/server/api';
import { cloneFromLibrary } from '@/lib/server/service';

/**
 * Cloning copies the definition and starts fresh tracking; the library entry is
 * unaffected. The response says which node type to filter the matrix to.
 */
export const POST = withAuth<{ id: string }>(async ({ actor, projectId, params, snapshot }) => {
  const result = await cloneFromLibrary(actor, projectId, params.id);
  return ok(await snapshot(), { module_id: result.moduleId, node_type: result.nodeType });
});
