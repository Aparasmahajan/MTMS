import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { removeColumn, setColumnCounts } from '@/lib/server/service';

const Body = z.object({ counts: z.boolean() });

export const PATCH = withAuth<{ key: string }>(async ({ actor, projectId, request, params, snapshot }) => {
  const body = await parseBody(request, Body);
  await setColumnCounts(actor, projectId, params.key, body.counts);
  return ok(await snapshot());
});

export const DELETE = withAuth<{ key: string }>(async ({ actor, projectId, params, snapshot }) => {
  await removeColumn(actor, projectId, params.key);
  return ok(await snapshot());
});
