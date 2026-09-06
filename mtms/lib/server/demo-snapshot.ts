import { DEMO_SIGNED_IN_AS } from '../demo/config';
import { buildSnapshot, defaultProjectId } from './service';
import { getStore } from './store';
import type { Snapshot } from '../shared/views';

/**
 * The projection the static demo is built from.
 *
 * This runs at **build time** during `next build` with `output: 'export'` — the seed is
 * read in Node, the real `buildSnapshot` produces the real projection, and the result is
 * serialised into the prerendered HTML. So the demo's opening numbers are not a fixture:
 * they are what the server would have sent.
 *
 * There is no session here, because a static page cannot have one. The demo is signed in
 * as the seeded admin and the role switcher in the header takes it from there.
 */
export async function buildDemoSnapshot(): Promise<Snapshot> {
  const store = await getStore();

  const user = store.users.find((candidate) => candidate.email === DEMO_SIGNED_IN_AS) ?? store.users[0];
  if (!user) throw new Error('The seed produced no users, so there is nobody to demo as.');

  const actor = {
    userId: user.id,
    tenantId: user.tenant_id,
    email: user.email,
    displayName: user.display_name,
  };

  return buildSnapshot(store, actor, defaultProjectId(store, actor));
}
