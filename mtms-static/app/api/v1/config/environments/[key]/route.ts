import { z } from 'zod';
import { ok, parseBody, withAuth } from '@/lib/server/api';
import { setEnvironmentEnabled } from '@/lib/server/service';

const Body = z.object({ enabled: z.boolean() });

/**
 * Switches one environment on or off for the current project.
 *
 * PATCH rather than DELETE on purpose: switching an environment off keeps every cell
 * recorded against it. Nothing here removes anything.
 */
export const PATCH = withAuth<{ key: string }>(
  async ({ actor, projectId, request, params, snapshot }) => {
    const body = await parseBody(request, Body);
    await setEnvironmentEnabled(actor, projectId, params.key, body.enabled);
    return ok(await snapshot());
  },
);
