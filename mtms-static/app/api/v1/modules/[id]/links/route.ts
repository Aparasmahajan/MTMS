import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { addLink } from '@/lib/server/service';

const Body = z.object({
  type: z.string().min(1),
  label: z.string().default(''),
  url: z.string().min(1),
});

export const POST = withAuth<{ id: string }>(async ({ actor, projectId, request, params, snapshot }) => {
  const body = await parseBody(request, Body);
  await addLink(actor, projectId, params.id, body);
  return ok(await snapshot());
});
