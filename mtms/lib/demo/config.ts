/**
 * Demo mode.
 *
 * `npm run build:demo` produces a fully static site — no Node server, no store on disk —
 * that a client can open from any static host. The build bakes the seeded projection into
 * the HTML and swaps the HTTP layer for an in-browser reducer, so every screen and every
 * derived number is the real one. Nothing persists: a reload restores the seed.
 *
 * The flag is read through `process.env.NEXT_PUBLIC_DEMO` so it is inlined at build time
 * and the demo branch is dead code in a normal build.
 */
export const IS_DEMO = process.env.NEXT_PUBLIC_DEMO === '1';

/** Who the demo is signed in as before anyone touches the role switcher. */
export const DEMO_SIGNED_IN_AS = 'parmahaj@nokia.com';
