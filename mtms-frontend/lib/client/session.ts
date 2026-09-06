import { cookies } from 'next/headers';
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

export async function fetchFromApi<T>(path: string): Promise<T | null> {
  const cookieHeader = sessionCookieHeader();
  if (!cookieHeader) return null;

  let response: Response;
  try {
    response = await fetch(apiUrl(path, SERVER_API_BASE_URL), {
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const body = (await response.json()) as { data?: T };
  return body.data ?? null;
}

/**
 * The projection every page under the app shell renders from.
 *
 * Reading a cookie already marks these pages dynamic, which is correct: a snapshot is
 * per-user and per-project and must never be cached at the edge.
 */
export async function requireSnapshot(): Promise<Snapshot> {
  const snapshot = await fetchFromApi<Snapshot>('/api/v1/snapshot');

  // A signed-in user with no readable project is a real state — a viewer removed from every
  // project — not a crash. Send them back to sign in rather than to a stack trace.
  if (!snapshot) redirect('/login');

  return snapshot;
}
