import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { advanceCell } from '@/lib/server/service';

const Body = z.object({
  sub_module_id: z.string().uuid(),
  sub_activity_id: z.string().uuid().nullable().default(null),
  column_key: z.string().min(1),
  /** Omit to advance through the column's configured statuses. */
  status: z.string().optional(),
});

/**
 * Cell editing is a click-to-advance cycle — no modal. Every advance writes an audit
 * entry, and a module cell that is a roll-up is refused here as well as disabled in
 * the UI.
 */
export const PATCH = withAuth(async ({ actor, projectId, request, snapshot }) => {
  const body = await parseBody(request, Body);
  await advanceCell(actor, projectId, {
    moduleId: body.sub_module_id,
    subactivityId: body.sub_activity_id,
    columnKey: body.column_key,
    status: body.status,
  });
  return ok(await snapshot());
});
