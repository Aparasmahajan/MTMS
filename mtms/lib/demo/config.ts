/**
 * Static mode.
 *
 * `npm run build` produces a fully static site — no Node server, no store on disk — that
 * anyone can open from any static host, or straight off a USB stick. The build bakes the
 * seeded projection into the HTML and swaps the HTTP layer for an in-browser reducer, so
 * every screen and every derived number is the real one.
 *
 * **Edits persist and cross tabs.** They are written to `localStorage` after every mutation
 * and broadcast to the other tabs of the same browser, which re-render at once. See
 * `lib/demo/persistence.ts`, which is also where the ceiling is written down: a second
 * *person* sees none of it, because `localStorage` is per browser and there is no server
 * between them. That needs `mtms-backend`.
 *
 * The flag is read through `process.env.NEXT_PUBLIC_DEMO` so it is inlined at build time.
 * It is set for every build in this repository — the flag survives because the code it
 * guards is shared with `mtms-frontend`, where it is false and the branches are dead code.
 */
export const IS_DEMO = process.env.NEXT_PUBLIC_DEMO === '1';

/**
 * Who the static build is signed in as before anyone touches the role switcher.
 *
 * Nitin, because he is the super admin: the demo opens on the whole product, including
 * the console above the organisation. The switcher then swaps the permission set without
 * changing the account, so the platform console stays reachable while a client watches
 * the project screens gate themselves as DevOps or as an intern.
 */
export const DEMO_SIGNED_IN_AS = 'nitin@azalio.io';
