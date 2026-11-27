import { NextResponse, type NextRequest } from 'next/server';

/**
 * Hands the requested path to server components.
 *
 * A server component cannot read the URL it is rendering, and `requireSnapshot` needs it: when
 * a page render finds the access token expired it sends the person to sign in with `next=` set,
 * so the silent refresh on the sign-in page can put them back on the page they asked for rather
 * than on the dashboard.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-mtms-path', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Pages only — not the API proxy, Next's own assets, or files.
  matcher: ['/((?!api/|_next/|favicon|.*\\.[a-z0-9]+$).*)'],
};
