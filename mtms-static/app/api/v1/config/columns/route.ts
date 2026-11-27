import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { addColumn } from '@/lib/server/service';

/**
 * What the Configure screen sends — `{ key, label, full, allowed, counts }` — or the older
 * `{ name }`, from which the rest is derived. This used to accept only `{ name }`, so the
 * screen's own request failed validation on a field it does not have.
 */
const Body = z.union([
  z.object({
    key: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1).max(12),
    full: z.string().trim().max(200).default(''),
    allowed: z.array(z.string()).min(1),
    counts: z.boolean().optional(),
  }),
  z.object({ name: z.string().trim().min(1) }),
]);

export const POST = withAuth(async ({ actor, projectId, request, snapshot }) => {
  const body = await parseBody(request, Body);
  await addColumn(actor, projectId, 'name' in body ? body.name : body);
  return ok(await snapshot());
});
