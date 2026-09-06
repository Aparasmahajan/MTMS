import { NextResponse } from 'next/server';
import { clearAuthCookie, readRefreshToken, withoutAuth } from '@/lib/server/api';
import { endSession } from '@/lib/server/sessions';

/**
 * Signing out revokes the whole refresh-token family, not just the token in hand — the
 * point of signing out is that the session is over, including any successor a racing tab
 * has already rotated into.
 */
export const POST = withoutAuth(async ({ request }) => {
  await endSession(readRefreshToken(request));
  return clearAuthCookie(NextResponse.json({ data: { ok: true } }));
});
