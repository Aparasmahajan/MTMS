import { apiUrl } from './config';

/**
 * The client half of the HTTP boundary. Unwraps `{ data, meta }`, and turns
 * `{ error: { message } }` into a thrown `ApiError` carrying the server's own wording —
 * the server writes the message the user reads, so the two never diverge.
 *
 * Every request goes to the Spring Boot service, cross-origin, with credentials. That is
 * the one difference from the version that shipped when the API was route handlers in this
 * repository, and it has two consequences worth stating:
 *
 * - `credentials: 'include'` is required or the session cookies are simply not sent. A
 *   cross-origin fetch omits cookies by default, and the failure looks like "logged out"
 *   rather than like a configuration mistake.
 * - The service must name this origin in `mtms.cors.allowed-origins`. A wildcard is not an
 *   option once credentials are involved — the browser refuses the combination.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Envelope<T> {
  data?: T;
  meta?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * One refresh at a time.
 *
 * An expired access cookie usually shows up as several 401s at once — a page render fires
 * more than one request. Without this they would each rotate the refresh token, and every
 * rotation after the first would present a spent token, which the service correctly treats
 * as a replay and answers by revoking the whole family. The first 401 starts the refresh
 * and the rest await the same promise.
 */
let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const response = await fetch(apiUrl('/api/v1/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Cleared after the awaiting callers have read the result.
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

export async function request<T>(
  path: string,
  init?: RequestInit,
  retryAfterRefresh = true,
): Promise<{ data: T; meta: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      credentials: 'include',
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
      cache: 'no-store',
    });
  } catch {
    // A cross-origin call that never lands is usually the service being down or CORS
    // refusing it, and the browser deliberately will not say which. Say so plainly rather
    // than reporting a generic failure that sends somebody looking in the wrong place.
    throw new ApiError(
      'unreachable',
      'Could not reach the API. Check that the service is running and that this origin is allowed.',
      0,
    );
  }

  let body: Envelope<T>;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    throw new ApiError('internal', 'The server sent a response we could not read.', response.status);
  }

  if (!response.ok || body.error) {
    // An expired access token is an ordinary state, not an error to show anyone: rotate
    // and replay once. A second 401 means the session is genuinely over.
    if (response.status === 401 && retryAfterRefresh && !path.startsWith('/api/v1/auth/')) {
      if (await refreshSession()) return request<T>(path, init, false);
    }
    throw new ApiError(
      body.error?.code ?? 'internal',
      body.error?.message ?? 'Something went wrong.',
      response.status,
    );
  }

  return { data: body.data as T, meta: body.meta ?? {} };
}

export const get = <T>(path: string) => request<T>(path);

export const send = <T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) =>
  request<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
