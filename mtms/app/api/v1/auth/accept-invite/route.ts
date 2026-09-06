import { NextResponse } from 'next/server';
import { z } from 'zod';
import { fail, parseBody, setAuthCookie, withoutAuth } from '@/lib/server/api';
import { hashPassword, hashToken, issueAccessToken } from '@/lib/server/auth';
import { mutate, nowIso } from '@/lib/server/store';

const Body = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Use at least 8 characters.'),
});

/** Invitation tokens are single-use and expiring: accepting one consumes it. */
export const POST = withoutAuth(async ({ request }) => {
  const body = await parseBody(request, Body);
  const tokenHash = hashToken(body.token);

  interface Accepted {
    error: string | null;
    user: { id: string; tenant_id: string; email: string; display_name: string } | null;
  }

  const outcome = await mutate<Accepted>(async (store) => {
    const user = store.users.find((candidate) => candidate.invite_token_hash === tokenHash);
    if (!user) return { error: 'That invitation link is not valid.', user: null };
    if (user.invite_expires_at && new Date(user.invite_expires_at).getTime() < Date.now()) {
      return { error: 'That invitation has expired. Ask an admin to send a new one.', user: null };
    }

    user.password_hash = await hashPassword(body.password);
    user.invite_token_hash = null;
    user.invite_expires_at = null;
    user.status = 'active';
    user.last_login_at = nowIso();

    const invitation = store.invitations.find(
      (candidate) => candidate.tenant_id === user.tenant_id && candidate.email === user.email,
    );
    if (invitation) invitation.accepted_at = nowIso();

    return {
      error: null,
      user: {
        id: user.id,
        tenant_id: user.tenant_id,
        email: user.email,
        display_name: user.display_name,
      },
    };
  });

  if (outcome.error || !outcome.user) {
    return fail('bad_request', outcome.error ?? 'That invitation link is not valid.');
  }

  const { token, expiresIn } = issueAccessToken({
    userId: outcome.user.id,
    tenantId: outcome.user.tenant_id,
    email: outcome.user.email,
    displayName: outcome.user.display_name,
  });

  return setAuthCookie(
    NextResponse.json({ data: { display_name: outcome.user.display_name } }),
    token,
    expiresIn,
  );
});
