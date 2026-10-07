/**
 * Where the API lives.
 *
 * This repository is the UI only. Every `/api/v1/...` path is served by the Spring Boot
 * service in `mtms-backend`, which is a separate program on a separate port and, in any
 * real deployment, a separate host.
 *
 * Two values, because a Next.js app fetches from two places:
 *
 * - {@link API_BASE_URL} is used by the browser. It must be an address the *user's*
 *   machine can reach, and it is inlined at build time — `NEXT_PUBLIC_` is not a naming
 *   convention, it is what makes the value exist in the bundle at all.
 * - {@link SERVER_API_BASE_URL} is used by server components. Inside a container network
 *   the service is often reachable at a name the browser cannot resolve (`http://api:6011`),
 *   so it is configured separately and falls back to the public one.
 *
 * An empty base is deliberately allowed: it makes every path relative, which is what you
 * want if the two are ever put behind one origin by a reverse proxy.
 */

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'https://mtms.azalio.io';

/**
 * Never relative, even when {@link API_BASE_URL} is.
 *
 * An empty base is the right answer for the browser — it makes every call same-origin, so
 * the Next.js rewrite in `next.config.mjs` proxies it and CORS never applies. But Node has
 * no notion of "the current page", so the same empty base makes a server component fetch
 * `/api/v1/...` against nothing and fail with a connection refused that looks like the API
 * being down. Falling back to the proxy target keeps the two halves consistent: the
 * browser goes through this server, this server goes straight to the API.
 */
export const SERVER_API_BASE_URL =
  process.env.API_BASE_URL ?? (API_BASE_URL || 'https://mtms.azalio.io');

/** Joins the base to an API path without producing a double slash. */
export function apiUrl(path: string, base: string = API_BASE_URL): string {
  if (!base) return path;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}
