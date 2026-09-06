# mtms-static

The whole tracker as static files. No server, no database, no login.

```bash
npm run build     # writes demo/
npm run serve     # http://localhost:4173
```

The output in `demo/` is plain files. Any static host will serve them — a share, an S3
bucket, GitHub Pages, a USB stick.

## What it does with your edits

**They persist.** Every mutation writes the whole snapshot to `localStorage`. Reload, close
the laptop, come back tomorrow — the work is still there, not the seed.

**They appear in your other tabs, live.** A `BroadcastChannel` carries each change to every
other tab of the same browser, and they re-render immediately. Two windows side by side stay
in step without either being refreshed.

**They do not reach anybody else.** `localStorage` is per browser, per origin. Two people on
two machines have two separate stores and nothing between them.

That last point is not a shortcoming of this implementation — it is what "no backend" means.
There is no server to carry a change from one person to another, and no amount of client-side
storage invents one. If two people need to see the same board, that is `../mtms-backend` and
`../mtms-frontend`.

`lib/demo/persistence.ts` is where all three behaviours live, and where the ceiling is
written down.

## What is real about it

Nearly everything. The build bakes the seeded projection into the HTML and swaps the HTTP
layer for an in-browser reducer at the one seam every screen already goes through
(`lib/client/api.ts`), so no screen knows the difference. Readiness, the subactivity roll-up,
stage bucketing, the drift verdicts and the promotion gate are computed by the same functions
in `lib/shared` that the Java service ports — so this cannot show a number the real
application would not.

The permission checks are mirrored too, which is what makes the role switcher in the header
genuinely gate the UI. In here they are a presentation choice, not a security boundary: the
real guarantee is the server-side check, and there is no server. Nothing in this build is
protecting anything, and it should not be pointed at real data.

## Tests

```bash
npm run build
npm run test:e2e
```

Four tests, in a real browser, against the built artefact:

- an edit survives a reload
- an edit in one tab appears in another without reloading it
- a tab opened later starts from the saved state, not the seed
- what is stored is a real snapshot, not just what is on screen

The last one exists because the first three could all pass while the stored copy was stale or
truncated — the screen would look right and the next reload would quietly lose the edit.

They test the artefact in `demo/`, so `npm run build` has to have run. Deliberately not
wired to rebuild automatically: a config that does turns a five-second test into a two-minute
one.
