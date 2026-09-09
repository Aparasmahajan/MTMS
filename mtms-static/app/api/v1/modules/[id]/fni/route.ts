import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { signOffFni } from '@/lib/server/service';

const Body = z.object({ close: z.boolean() });

/**
 * The FNI rule, step 5 — closing the module and its subactivities. Permitted only
 * when readiness is 100% and the FNI column is done; the gate is recomputed here from
 * the store rather than trusted from the client.
 */
export const POST = withAuth<{ id: string }>(async ({ actor, projectId, request, params, snapshot }) => {
  const body = await parseBody(request, Body);
  await signOffFni(actor, projectId, params.id, body.close);
  return ok(await snapshot());
});
