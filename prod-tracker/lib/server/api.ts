import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodTypeAny, type output } from 'zod';
import { ACCESS_COOKIE, verifyAccessToken, type Actor } from './auth';
import { ServiceError, STATUS_BY_CODE, type ErrorCode } from './errors';
import { buildSnapshot, defaultProjectId } from './service';
import { getStore } from './store';
import type { Snapshot } from '../shared/views';

/**
 * The HTTP boundary, following the TMS pattern: every response is `{ data, meta }` or
 * `{ error: { code, message, details } }`, and the tenant comes from the token claim
 * and from nowhere else — not a query parameter, not a header, not a body field.
 */

export const PROJECT_COOKIE = 'tracker_project';

export function ok<T>(data: T, meta?: Record<string, unknown>): NextResponse {
  return NextResponse.json(meta ? { data, meta } : { data });
}

export function fail(code: ErrorCode, message: string, details?: unknown): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status: STATUS_BY_CODE[code] },
  );
}

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ServiceError) return fail(error.code, error.message, error.details);
  if (error instanceof ZodError) {
    return fail('validation_failed', 'That request did not pass validation', error.flatten());
  }
  console.error('[api] unhandled error at the boundary', error);
  return fail('internal', 'Something went wrong on our side.');
}

export function readAccessToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return request.cookies.get(ACCESS_COOKIE)?.value ?? null;
}

export interface RouteContext<P = Record<string, string>> {
  actor: Actor;
  projectId: string;
  request: NextRequest;
  params: P;
  /** The projection every mutation returns, so one round trip refreshes the screen. */
  snapshot: () => Promise<Snapshot>;
}

type Handler<P> = (context: RouteContext<P>) => Promise<NextResponse> | NextResponse;

// Writes only, per user — the same shape as the TMS limiter.
const writeCounters = new Map<string, { count: number; windowStart: number }>();
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const WRITE_LIMIT_PER_MINUTE = Number(process.env.WRITE_RATE_LIMIT) || 300;

function withinWriteRate(userId: string): boolean {
  const now = Date.now();
  const entry = writeCounters.get(userId);
  if (!entry || now - entry.windowStart > 60_000) {
    writeCounters.set(userId, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= WRITE_LIMIT_PER_MINUTE;
}

/** Wraps a route handler with auth, project resolution, rate limiting and error translation. */
export function withAuth<P extends Record<string, string> = Record<string, string>>(
  handler: Handler<P>,
): (request: NextRequest, context: { params: P }) => Promise<NextResponse> {
  return async (request, context) => {
    const token = readAccessToken(request);
    if (!token) return fail('unauthenticated', 'Sign in to continue');

    const actor = verifyAccessToken(token);
    if (!actor) return fail('unauthenticated', 'Your session has expired. Sign in again.');

    if (WRITE_METHODS.has(request.method) && !withinWriteRate(actor.userId)) {
      return fail('rate_limited', 'Too many changes in a short time. Try again in a moment.');
    }

    try {
      const store = await getStore();
      const requested =
        new URL(request.url).searchParams.get('project') ??
        request.cookies.get(PROJECT_COOKIE)?.value ??
        null;

      const projectId =
        requested && store.projects.some((p) => p.id === requested && p.tenant_id === actor.tenantId)
          ? requested
          : defaultProjectId(store, actor);

      return await handler({
        actor,
        projectId,
        request,
        params: (context?.params ?? {}) as P,
        snapshot: async () => buildSnapshot(await getStore(), actor, projectId),
      });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

/** For the handful of routes that run before there is a session. */
export function withoutAuth(
  handler: (context: { request: NextRequest }) => Promise<NextResponse> | NextResponse,
): (request: NextRequest) => Promise<NextResponse> {
  return async (request) => {
    try {
      return await handler({ request });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export async function parseBody<S extends ZodTypeAny>(
  request: NextRequest,
  schema: S,
): Promise<output<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ServiceError('bad_request', 'Expected a JSON body');
  }
  return schema.parse(raw) as output<S>;
}

export function setAuthCookie(response: NextResponse, token: string, maxAge: number): NextResponse {
  response.cookies.set(ACCESS_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  });
  return response;
}

export function clearAuthCookie(response: NextResponse): NextResponse {
  response.cookies.set(ACCESS_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
