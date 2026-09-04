import { NextResponse } from 'next/server';
import { z } from 'zod';
import { fail, parseBody, setAuthCookie, withoutAuth } from '@/lib/server/api';
import { issueAccessToken, verifyPassword } from '@/lib/server/auth';
import { getStore, mutate, nowIso } from '@/lib/server/store';

const Body = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
});

export const POST = withoutAuth(async ({ request }) => {
  const body = await parseBody(request, Body);
  const email = body.email.toLowerCase();

  const store = await getStore();
  const user = store.users.find((candidate) => candidate.email.toLowerCase() === email);

  // One message for both causes, so the response cannot enumerate accounts.
  const rejection = 'That email and password do not match an active account.';

  if (!user || user.status === 'deactivated' || !user.password_hash) {
    if (user?.status === 'invited') {
      return fail(
        'forbidden',
        'This invitation has not been accepted yet. Use the link in your invitation email.',
      );
    }
    return fail('unauthenticated', rejection);
  }

  if (!(await verifyPassword(body.password, user.password_hash))) {
    return fail('unauthenticated', rejection);
  }

  await mutate((data) => {
    const row = data.users.find((candidate) => candidate.id === user.id);
    if (row) row.last_login_at = nowIso();
  });

  const { token, expiresIn } = issueAccessToken({
    userId: user.id,
    tenantId: user.tenant_id,
    email: user.email,
    displayName: user.display_name,
  });

  return setAuthCookie(
    NextResponse.json({ data: { display_name: user.display_name, email: user.email } }),
    token,
    expiresIn,
  );
});
