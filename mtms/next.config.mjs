/**
 * One config, two builds.
 *
 * The normal build is a Node server: route handlers, a session cookie, the file-backed
 * store. `npm run build:demo` sets NEXT_PUBLIC_DEMO=1 and switches on a static export —
 * plain HTML a client can host anywhere, with the seeded projection baked in and the
 * HTTP layer answered in the browser. See lib/demo/config.ts.
 */
const isDemo = process.env.NEXT_PUBLIC_DEMO === '1';

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
    : {}),
};

export default nextConfig;
