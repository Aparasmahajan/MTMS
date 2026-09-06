import { IS_DEMO } from '@/lib/demo/config';

/**
 * The client half of the HTTP boundary. Unwraps `{ data, meta }`, and turns
 * `{ error: { message } }` into a thrown `ApiError` carrying the server's own wording —
 * the server writes the message the user reads, so the two never diverge.
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
 * rotation after the first would present a spent token and revoke the whole family. So the
 * first 401 starts the refresh and the rest await the same promise.
 */
let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const response = await fetch('/api/v1/auth/refresh', { method: 'POST', cache: 'no-store' });
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
  // The static client demo has no server. It answers here, at the one seam every screen
  // already goes through, so nothing above this line knows the difference.
  if (IS_DEMO) {
    const { demoRequest } = await import('@/lib/demo/runtime');
    const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const result = demoRequest(path, init?.method ?? 'GET', parsed as Record<string, unknown>);
    return { data: result.data as T, meta: result.meta };
  }

  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
    cache: 'no-store',
  });

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
