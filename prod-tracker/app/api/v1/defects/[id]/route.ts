import { z } from 'zod';
import { DefectStatus } from '@/lib/shared/domain';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { assignDefect, transitionDefect } from '@/lib/server/service';

/**
 * Omit both to cycle Open → Investigating → Fixed, which is what the table does.
 * `assignee: null` unassigns. The two are separate permissions, so a body carrying both
 * is applied as two checked changes rather than one.
 */
const Body = z.object({
  status: DefectStatus.optional(),
  assignee: z.string().nullable().optional(),
});

export const PATCH = withAuth<{ id: string }>(async ({ actor, projectId, request, params, snapshot }) => {
  const body = await parseBody(request, Body);

  if (body.assignee !== undefined) {
    await assignDefect(actor, projectId, params.id, body.assignee);
  }
  if (body.status !== undefined || body.assignee === undefined) {
    await transitionDefect(actor, projectId, params.id, body.status);
  }

  return ok(await snapshot());
});
