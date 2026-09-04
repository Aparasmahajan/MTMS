import { ok, withAuth } from '@/lib/server/api';

/**
 * Everything the ten screens read, in one projection. The project is a few hundred
 * cells, so one round trip beats per-screen queries — and this is the response the
 * README's Redis cache would sit in front of.
 */
export const GET = withAuth(async ({ snapshot }) => ok(await snapshot()));
