import { NextResponse } from 'next/server';
import { clearAuthCookie, readRefreshToken, setSessionCookies, toErrorResponse, withoutAuth } from '@/lib/server/api';
import { rotateSession } from '@/lib/server/sessions';

/**
 * Exchanges the refresh cookie for a fresh pair.
 *
 * Every exchange rotates: the presented token is spent and a successor issued in the same
 * family. Presenting a spent token means two parties hold it, so the family is revoked and
 * both are signed out — see `lib/server/sessions.ts`.
 *
 * On failure the cookies are cleared, so a client that has lost its session lands on the
 * sign-in screen rather than looping on a token that will never work again.
 */
export const POST = withoutAuth(async ({ request }) => {
  const presented = readRefreshToken(request);
  if (!presented) {
    return clearAuthCookie(
      NextResponse.json(
        { error: { code: 'unauthenticated', message: 'Sign in to continue' } },
        { status: 401 },
      ),
    );
  }

  try {
    const session = await rotateSession(presented);
    return setSessionCookies(NextResponse.json({ data: { ok: true } }), session);
  } catch (error) {
    return clearAuthCookie(toErrorResponse(error));
  }
});
