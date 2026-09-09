import { ok, withAuth } from '@/lib/server/api';
import { removeLink } from '@/lib/server/service';

export const DELETE = withAuth<{ id: string }>(async ({ actor, projectId, params, snapshot }) => {
  await removeLink(actor, projectId, params.id);
  return ok(await snapshot());
});
