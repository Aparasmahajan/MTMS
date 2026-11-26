import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SERVER_API_BASE_URL, apiUrl } from './config';
import type { Snapshot } from '../shared/views';

/**
 * The server-component half of the session.
 *
 * When the API lived in this repository, pages read the store directly and skipped a round
 * trip. They cannot now — the store is the Spring service's — so this fetches the same
 * projection over HTTP and forwards the browser's cookies so the service sees the right
 * user.
 *
 * Forwarding is manual and deliberate. `fetch` inside a server component has no cookie jar:
 * it is a separate program making its own outbound request, and nothing is attached unless
 * it is attached here. Omitting it does not fail loudly — the service simply answers 401,
 * and every page redirects to the login screen for no visible reason.
 *
 * Only the two session cookies are forwarded, not the whole header. Anything else the
 * browser happens to hold for this origin is nothing to do with the API.
 */

const FORWARDED = ['tracker_at', 'mtms_rt', 'tracker_project'];

function sessionCookieHeader(): string {
  const jar = cookies();
  return FORWARDED.map((name) => {
    const value = jar.get(name)?.value;
    return value ? `${name}=${value}` : null;
  })
    .filter(Boolean)
    .join('; ');
}

/** What a server-side read came back with: the data, or why there is none. */
type ApiRead<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string | null };

export async function readFromApi<T>(path: string): Promise<ApiRead<T>> {
  const cookieHeader = sessionCookieHeader();
  if (!cookieHeader) return { ok: false, status: 401, message: null };

  let response: Response;
  try {
    response = await fetch(apiUrl(path, SERVER_API_BASE_URL), {
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, message: 'Could not reach the service. Try again in a moment.' };
  }

  let body: { data?: T; error?: { message?: string } } = {};
  try {
    body = await response.json();
  } catch {
    // An unreadable body is handled by the status below.
  }

  if (!response.ok || body.data == null) {
    return { ok: false, status: response.status, message: body.error?.message ?? null };
  }
  return { ok: true, data: body.data };
}

export async function fetchFromApi<T>(path: string): Promise<T | null> {
  const read = await readFromApi<T>(path);
  return read.ok ? read.data : null;
}

/** The page being rendered, as the middleware recorded it — only ever a same-site path. */
function currentPath(): string | null {
  const path = headers().get('x-mtms-path');
  return path && path.startsWith('/') && !path.startsWith('//') ? path : null;
}

/**
 * The projection every page under the app shell renders from.
 *
 * Reading a cookie already marks these pages dynamic, which is correct: a snapshot is
 * per-user and per-project and must never be cached at the edge.
 *
 * **A 401 here is usually not the end of a session.** The access cookie lives fifteen minutes;
 * the refresh cookie lives thirty days but is scoped to `/api/v1/auth`, so the browser never
 * sends it with a page request and this render cannot rotate it. Redirecting to a bare sign-in
 * screen logged everybody out a quarter of an hour after their last click. Instead the sign-in
 * page is told where they were going, tries a silent refresh first — from the browser, where
 * the refresh cookie *is* sent — and only asks for a password if that fails.
 *
 * Anything else — no project to open, a removed account — is a real state with a sentence
 * the service already wrote, and it is shown rather than thrown away.
 */
export async function requireSnapshot(): Promise<Snapshot> {
  const read = await readFromApi<Snapshot>('/api/v1/snapshot');
  if (read.ok) return read.data;

  const next = currentPath();
  if (read.status === 401) {
    redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  }

  const reason =
    read.message ??
    (read.status === 0
      ? 'Could not reach the service. Try again in a moment.'
      : 'That account cannot open any project in this organisation.');
  redirect(`/login?denied=1&reason=${encodeURIComponent(reason)}`);
}
