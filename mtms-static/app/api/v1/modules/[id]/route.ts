import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { setModuleFields } from '@/lib/server/service';

const Body = z.object({
  owner: z.string().nullable().optional(),
  fni_target_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.literal(''))
    .nullable()
    .optional(),
});

export const PATCH = withAuth<{ id: string }>(async ({ actor, projectId, request, params, snapshot }) => {
  const body = await parseBody(request, Body);
  await setModuleFields(actor, projectId, params.id, {
    ...(body.owner !== undefined ? { owner: body.owner } : {}),
    ...(body.fni_target_date !== undefined ? { fniTargetDate: body.fni_target_date } : {}),
  });
  return ok(await snapshot());
});
