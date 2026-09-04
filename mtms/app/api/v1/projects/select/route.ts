import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PROJECT_COOKIE, parseBody, withAuth } from '@/lib/server/api';
import { buildSnapshot } from '@/lib/server/service';
import { getStore } from '@/lib/server/store';

const Body = z.object({ project_id: z.string().uuid() });

/** The org + project switcher. The chosen project rides in a cookie, not the URL. */
export const POST = withAuth(async ({ actor, request }) => {
  const body = await parseBody(request, Body);
  const store = await getStore();

  // buildSnapshot re-checks tenancy and project.view, so an unauthorised id fails here.
  const snapshot = buildSnapshot(store, actor, body.project_id);

  const response = NextResponse.json({ data: snapshot });
  response.cookies.set(PROJECT_COOKIE, body.project_id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  return response;
});
