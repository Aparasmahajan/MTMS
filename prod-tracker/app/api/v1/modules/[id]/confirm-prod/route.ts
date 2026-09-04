import { ok, withAuth } from '@/lib/server/api';
import { confirmLoadedInProd } from '@/lib/server/service';

/** DevOps confirming step 3 of the chain: every counted deliverable loaded in prod. */
export const POST = withAuth<{ id: string }>(async ({ actor, projectId, params, snapshot }) => {
  const { changed } = await confirmLoadedInProd(actor, projectId, params.id);
  return ok(await snapshot(), { changed });
});
