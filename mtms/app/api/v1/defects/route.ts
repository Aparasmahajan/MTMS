import { z } from 'zod';
import { DefectPhase, DefectSeverity } from '@/lib/shared/domain';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { createDefect } from '@/lib/server/service';

const Body = z.object({
  module_id: z.string().uuid(),
  phase: DefectPhase,
  ticket_key: z.string().default(''),
  child_req_id: z.string().default(''),
  severity: DefectSeverity,
  description: z.string().trim().min(1, 'Say what happened on the node.'),
});

export const POST = withAuth(async ({ actor, projectId, request, snapshot }) => {
  const body = await parseBody(request, Body);
  await createDefect(actor, projectId, {
    moduleId: body.module_id,
    phase: body.phase,
    ticketKey: body.ticket_key,
    childReqId: body.child_req_id,
    severity: body.severity,
    description: body.description,
  });
  return ok(await snapshot());
});
