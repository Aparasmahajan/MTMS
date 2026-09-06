import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { moveColumn, removeColumn, setColumnCounts, setColumnStatuses } from '@/lib/server/service';

/**
 * One PATCH for the three things a column carries: whether it counts toward prod, the
 * statuses it may take, and where it sits on the matrix. Each is applied only if present,
 * so the screen can send whichever the user just changed.
 */
const Body = z
  .object({
    counts: z.boolean().optional(),
    allowed: z.array(z.string()).min(1).optional(),
    move: z.enum(['up', 'down']).optional(),
  })
  .refine(
    (body) => body.counts !== undefined || body.allowed !== undefined || body.move !== undefined,
    { message: 'Nothing to change — send counts, allowed or move.' },
  );

export const PATCH = withAuth<{ key: string }>(async ({ actor, projectId, request, params, snapshot }) => {
  const body = await parseBody(request, Body);

  if (body.counts !== undefined) {
    await setColumnCounts(actor, projectId, params.key, body.counts);
  }
  if (body.allowed !== undefined) {
    await setColumnStatuses(actor, projectId, params.key, body.allowed);
  }
  if (body.move !== undefined) {
    await moveColumn(actor, projectId, params.key, body.move);
  }

  return ok(await snapshot());
});

export const DELETE = withAuth<{ key: string }>(async ({ actor, projectId, params, snapshot }) => {
  await removeColumn(actor, projectId, params.key);
  return ok(await snapshot());
});
