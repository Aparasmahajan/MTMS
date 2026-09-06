import { z } from 'zod';
import { ConfigList } from '@/lib/shared/domain';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { updateConfigList } from '@/lib/server/service';

const Body = z.object({
  list: ConfigList,
  action: z.enum(['add', 'remove']),
  value: z.string().min(1),
});

/** The four editable sets on the Configure screen: node types, stages, owners, link types. */
export const POST = withAuth(async ({ actor, projectId, request, snapshot }) => {
  const body = await parseBody(request, Body);
  await updateConfigList(actor, projectId, body.list, body.action, body.value);
  return ok(await snapshot());
});
