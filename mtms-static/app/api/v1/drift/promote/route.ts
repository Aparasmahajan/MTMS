import { z } from 'zod';
import { DriftEnvironment } from '@/lib/shared/domain';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { promoteDrift } from '@/lib/server/service';

const Body = z.object({
  from: DriftEnvironment.default('preprod'),
  to: DriftEnvironment.default('prod'),
});

/**
 * Records a promotion. The gate is recomputed here from the store — a client that thinks
 * it is open does not make it open — and nothing is written to the target environment,
 * because only an agent report can say what is actually on it.
 */
export const POST = withAuth(async ({ actor, projectId, request, snapshot }) => {
  const body = await parseBody(request, Body);
  const result = await promoteDrift(actor, projectId, body.from, body.to);
  return ok(await snapshot(), { promotion_id: result.promotionId, columns: result.columns });
});
