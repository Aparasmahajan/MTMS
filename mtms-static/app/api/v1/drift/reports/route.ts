import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { DriftEnvironment, DriftLayer } from '@/lib/shared/domain';
import { fail, ok, toErrorResponse } from '@/lib/server/api';
import { verifyAccessToken, ACCESS_COOKIE } from '@/lib/server/auth';
import { ingestDriftReport, defaultProjectId, resolveAccess } from '@/lib/server/service';
import { getStore } from '@/lib/server/store';

/**
 * The drift ingest.
 *
 * The caller is an **agent on a server**, not a person, so this route does not use the
 * session cookie path. It takes a bearer token from `DRIFT_INGEST_TOKEN`; a signed-in
 * user holding `prod.confirm` may also post, which is what makes it testable by hand.
 *
 * Hashes only. There is no field for file content and there never should be: `mds.rc.add`
 * carries plaintext CMM/M2M/repo passwords, and an ingest that accepted content would
 * pull them into the store and onto a screen.
 */

const Entry = z.object({
  column_key: z.string().min(1),
  layer: DriftLayer,
  path: z.string().min(1).max(500),
  content_hash: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Expected a hex sha256'),
  size_bytes: z.number().int().nonnegative().optional(),
  built_at: z.string().datetime().nullable().optional(),
  source_modified_at: z.string().datetime().nullable().optional(),
  in_packinglist: z.boolean().optional(),
});

const Body = z.object({
  environment: DriftEnvironment,
  agent: z.string().min(1).max(120),
  project_key: z.string().optional(),
  entries: z.array(Entry).max(5000),
});

function tokenMatches(given: string): boolean {
  const expected = process.env.DRIFT_INGEST_TOKEN;
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const header = request.headers.get('authorization') ?? '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

    const store = await getStore();
    let authorised = bearer !== '' && tokenMatches(bearer);
    let projectId: string | null = null;
    let actorName = 'agent';

    if (!authorised) {
      // Fall back to a session, so an admin can replay a report by hand while setting up.
      const cookie = request.cookies.get(ACCESS_COOKIE)?.value;
      const actor = cookie ? verifyAccessToken(cookie) : null;
      if (!actor) {
        return fail('unauthenticated', 'This endpoint needs the drift ingest token.');
      }
      projectId = defaultProjectId(store, actor);
      const access = resolveAccess(store, actor, projectId);
      if (!access.permissions.has('prod.confirm')) {
        return fail('forbidden', 'Reporting hashes needs prod.confirm, or the ingest token.');
      }
      authorised = true;
      actorName = actor.displayName;
    }

    const body = Body.parse(await request.json());

    // A token-authenticated agent has no session, so it names its project explicitly.
    if (!projectId) {
      const project = body.project_key
        ? store.projects.find((candidate) => candidate.key === body.project_key)
        : store.projects.find((candidate) => candidate.configured);
      if (!project) {
        return fail('not_found', `No project matches ${body.project_key ?? 'the default'}.`);
      }
      projectId = project.id;
    }

    const result = await ingestDriftReport(projectId, {
      environment: body.environment,
      agent: body.agent,
      entries: body.entries,
    });

    return ok(
      {
        accepted: result.accepted,
        ignored: result.ignored,
        confirmed_promotions: result.confirmed_promotions,
      },
      { reported_by: actorName },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
