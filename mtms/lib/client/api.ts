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

export async function request<T>(
  path: string,
  init?: RequestInit,
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
