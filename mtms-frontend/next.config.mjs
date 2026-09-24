/**
 * One config, two builds.
 *
 * The normal build is a Node server: route handlers, a session cookie, the file-backed
 * store. `npm run build:demo` sets NEXT_PUBLIC_DEMO=1 and switches on a static export —
 * plain HTML a client can host anywhere, with the seeded projection baked in and the
 * HTTP layer answered in the browser. See lib/demo/config.ts.
 */
const isDemo = process.env.NEXT_PUBLIC_DEMO === '1';

/**
 * Where this server forwards `/api/*` when the browser is told to use relative paths.
 *
 * **Fixed at build time**, not at run time: Next.js evaluates `rewrites()` during the build
 * and writes the result into `routes-manifest.json`, so setting `API_PROXY_TARGET` on
 * `next start` has no effect. Set it on the build, or leave the default.
 *
 * The default is deliberately loopback. The point of the proxy is that the *public* address
 * is never compiled in — only this private hop is, and it is the same on every machine, so
 * one build still works on localhost, on an IP, and on a domain later.
 */
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'https://mtms.azalio.io';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(isDemo
    ? {
        output: 'export',
        // Directory-style URLs, so /matrix/ resolves without host rewrite rules.
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {
        /**
         * A self-contained build, the same shape as the backend's JAR.
         *
         * `.next/standalone` gets its own `server.js` and only the `node_modules` actually
         * reached at run time — tens of megabytes instead of the whole dependency tree. The
         * server then needs nothing installed but Node itself, so deploying is copying one
         * directory rather than running `npm ci` on a machine that may have no network.
         */
        output: 'standalone',

        /**
         * Serve the API under the web app's own origin.
         *
         * Three problems disappear at once, and they are the three that break a first
         * deployment:
         *
         * 1. **CORS.** Same origin, so `mtms.cors.allowed-origins` never has to match
         *    whatever address the user typed.
         * 2. **Cookies.** `lib/client/api.ts` sends `credentials: 'include'`, and a
         *    cross-origin cookie needs `SameSite=None; Secure` — which means HTTPS. Same
         *    origin needs none of that, so sign-in works over plain HTTP.
         * 3. **One open port.** Only this server is exposed; the API can bind to localhost
         *    and never be reachable from outside at all.
         *
         * A static export cannot rewrite — there is no server — so the demo build keeps
         * talking to the API directly.
         */
        async rewrites() {
          return [{ source: '/api/:path*', destination: `${apiProxyTarget}/api/:path*` }];
        },
      }),
};

export default nextConfig;
