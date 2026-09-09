import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACCESS_COOKIE, verifyAccessToken, type Actor } from './auth';
import { PROJECT_COOKIE } from './api';
import { ServiceError } from './errors';
import { buildSnapshot, defaultProjectId } from './service';
import { getStore } from './store';
import type { Snapshot } from '../shared/views';

/**
 * Server-component session. Pages render from the store directly rather than fetching
 * their own API — same projection, no extra round trip — while every *mutation* still
 * goes through the HTTP boundary where permissions are enforced.
 */

export function currentActor(): Actor | null {
  const token = cookies().get(ACCESS_COOKIE)?.value;
  return token ? verifyAccessToken(token) : null;
}

export async function requireSnapshot(): Promise<Snapshot> {
  const actor = currentActor();
  if (!actor) redirect('/login');

  const store = await getStore();
  const requested = cookies().get(PROJECT_COOKIE)?.value;
  const projectId =
    requested && store.projects.some((p) => p.id === requested && p.tenant_id === actor.tenantId)
      ? requested
      : defaultProjectId(store, actor);

  try {
    return buildSnapshot(store, actor, projectId);
  } catch (error) {
    // A signed-in user with no readable project is a real state (a viewer removed from
    // every project), not a crash — send them back to sign in rather than a stack trace.
    if (error instanceof ServiceError && error.code !== 'internal') redirect('/login?denied=1');
    throw error;
  }
}
