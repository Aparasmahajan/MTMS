import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { addColumn } from '@/lib/server/service';

const Body = z.object({ name: z.string().trim().min(1) });

export const POST = withAuth(async ({ actor, projectId, request, snapshot }) => {
  const body = await parseBody(request, Body);
  await addColumn(actor, projectId, body.name);
  return ok(await snapshot());
});
