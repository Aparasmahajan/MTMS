import { z } from 'zod';
import { DefectStatus } from '@/lib/shared/domain';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { transitionDefect } from '@/lib/server/service';

/** Omit `status` to cycle Open → Investigating → Fixed, which is what the table does. */
const Body = z.object({ status: DefectStatus.optional() });

export const PATCH = withAuth<{ id: string }>(async ({ actor, projectId, request, params, snapshot }) => {
  const body = await parseBody(request, Body);
  await transitionDefect(actor, projectId, params.id, body.status);
  return ok(await snapshot());
});
