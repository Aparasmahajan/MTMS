# Pending — Flow One Prod Tracker

**Handoff document.** Written to be read cold, with no prior conversation. Part 1 is
built, runs and is verified; Parts 2–6 below are not started.

---

## Start here

1. Read [README.md](README.md) — what the app is and how to run it (~5 min).
2. Read [completed.md](completed.md) — exactly what Part 1 delivered and how it was verified.
3. Read `lib/shared/vocabulary.ts` — ~150 lines, and the single most important file. The
   roll-up rule and readiness live there as pure functions. The server enforces the FNI
   gate with the same code the client renders the matrix with.
4. Read the design bundle one directory up — `../README.md` is the customer handoff and is
   the authority on intent; `../Prod Tracker.dc.html` is the design; `../NEI_CONTEXT.md`
   is the system underneath (read before touching Drift).

```bash
cd tracker/prod-tracker
npm install
npm run dev          # http://localhost:3100
```

Sign in `parmahaj@nokia.com` / `tracker` (Admin), or `k.menon@nokia.com` / `tracker`
(Viewer) to see permission gating.

### Where things are

```
lib/shared/     vocabulary · permissions · domain · views   ← pure, imported by both sides
lib/server/     store · seed · auth · api · errors · service · session
lib/client/     api · optimistic
components/     AppShell · TrackerProvider · primitives
app/(app)/      page(dashboard) matrix defects pipeline modules/[id] library access drift configure
app/api/v1/     18 route handlers
```

---

## Ground rules — follow these or the app becomes inconsistent

These are not style preferences; each one is load-bearing.

1. **Never hard-code the fourteen deliverable columns** anywhere above `lib/server/seed.ts`.
   Columns are project configuration. If you find yourself writing `'filecr'` outside the
   seed, stop. (Two deliberate exceptions exist and are commented: the FNI gate looks up
   the `fni` column, and the dashboard counts the `ritm` column for its gap figure.)
2. **A blank (`''`) is not a status.** It means someone forgot. It has its own tone,
   renders with a full ink border, and counts as a gap. Never coerce it to "not done".
3. **A module cell with subactivities is derived, never stored.** `advanceCell` refuses to
   write one and the UI opens the subactivities instead. Do not add a path around this.
4. **Every mutation re-checks permissions server-side** via `require_(access, key, what)`
   in `lib/server/service.ts`. The client's permission set exists only to disable controls
   and explain why.
5. **Every mutation route returns the full fresh `Snapshot`** and the client replaces state
   with it. Keep this — it is why the dashboard updates when you click a matrix cell.
6. **Gate, don't hide.** A control the user cannot use renders at reduced opacity with the
   reason stated, via `reasonFor(key)` from `useTracker()`.
7. **Status is carried by fill, outline and glyph — never by colour alone.** No red/amber/
   green anywhere. The only decorative colour is the steel accent.
8. **Cards, figures and buttons are square.** Never add a border radius. Framed elements
   always keep their four `+` corner registration marks (use `<Blueprint>`).

### Conventions you will need

- **Adding a mutation:** write the function in `lib/server/service.ts` (call `require_`
  first, then `mutate((store) => …)`), then a thin route handler using `withAuth`, which
  hands you `{ actor, projectId, request, params, snapshot }`. Return `ok(await snapshot())`.
- **Client side:** `useTracker().apply(optimisticFn | null, callFn)`. Pass `null` for the
  optimistic argument unless the interaction must feel instant (only cell edits do). It
  queues, rolls back on failure and surfaces the server's own message.
- **Optimistic updates** must recompute derived fields with the shared pure functions —
  see `lib/client/optimistic.ts` and `withDerived`. Never hand-roll the maths.

### Gotchas that will cost you an hour each

- `tsconfig.json` sets **`noUncheckedIndexedAccess: true`**. `array[0]` is `T | undefined`.
- **Next.js page files may only export a default component** plus Next's own config
  exports. Exporting a helper from `app/**/page.tsx` fails the build.
- **`JWT_SECRET` is required in production.** `npm run build && npm start` without it
  returns 500 on login — by design, in `lib/server/auth.ts`.
- **The session cookie is `Secure` in production**, so `next start` over plain HTTP will
  not keep a browser session. Use `npm run dev` locally.
- **Delete `data/tracker.json` to reseed.** Bumping `STORE_VERSION` in `lib/server/store.ts`
  forces the same thing on next start.
- The store is a single JSON document held in memory with serialised writes. Correct for a
  pilot, wrong for more than one process — see Part 6.

---

# Part 2 — Tests

Nothing is tested. Vitest is installed and configured as a dependency but there is no test
file and no `vitest.config.ts`. Do this first: every later part changes the rules below,
and without tests you will not know what you broke.

### 2.1 The pure rules — `lib/shared/vocabulary.ts`

Create `lib/shared/__tests__/vocabulary.test.ts`.

- `rollUp` truth table, in precedence order: **blank beats not-done beats in-progress beats
  done**. Assert it returns the *actual status* of the first subactivity at the governing
  tone (not a synthetic one), and returns `BLANK` for an empty list.
- `readiness` — done ÷ counted, rounded; `0` when there are no counted columns; blanks and
  in-progress both count against.
- `stageIndex` — at 0, 1, 49, 50, 99, 100, across 2, 6 and 8 stages. 100% must always land
  on the last stage and nothing else may.
- `nextStatus` — wraps at the end; returns `current` for an empty allowed list; starts the
  cycle correctly from `BLANK` (a blank is not in any column's allowed list, so
  `indexOf` is `-1` and the first status must come out).

### 2.2 The service rules — `lib/server/service.ts`

Create `lib/server/__tests__/service.test.ts`. Point the store at a temp file per test with
`TRACKER_STORE_PATH` and call `resetStoreCache()` between tests.

- **FNI gate**: refused below 100%; refused at 100% with the FNI column not done; permitted
  when both hold; the blocking reasons come back verbatim.
- **Roll-up guard**: writing a module cell that has subactivities is refused.
- **Closed module**: `advanceCell` and `confirmLoadedInProd` are refused; reopening allows
  them again.
- **Permissions**: a Viewer is refused every mutation; DevOps may `confirmLoadedInProd` but
  not `signOffFni`.
- **`toggleGrant`** refuses to grant a permission the actor does not hold themselves.
- **`inviteUser`** refuses a role holding permissions the actor lacks.
- **`removeColumn`** deletes the column's cells with it, and only in that project.
- **`cloneFromLibrary`** does not mutate the library entry's definition, creates the module
  with every cell blank, and adds the node type to the project if missing.

### 2.3 Regression fixture

Assert the seeded projection against known-good numbers, so a change to the rules is caught
loudly: **18 modules, 14 columns, 3 fully in prod, 3 not started, 86 blank cells**, and
`128_TGRP_CONFIGURATION_IN_CFX` at **58%** with 3 subactivities. These match the design
prototype's own maths and were verified by hand.

**Done when:** `npm test` passes and `package.json`'s `test` script runs it.

---

# Part 3 — Finish "generic without a code change"

This is the largest *product* gap. The app is configurable in most respects but not all,
and the unconfigurable parts are the ones the design bundle is most emphatic about.

### 3.1 Editable column status subsets — the priority

Today a column's allowed statuses are fixed at creation: the seed sets them per column, and
`addColumn` always uses `STATUS_SETS.simple` (Not Loaded / Loaded). Configure *displays*
them as outline tags but cannot change them.

- Extend `PATCH /api/v1/config/columns/[key]` — it currently accepts only `{ counts }` — to
  accept `{ allowed: string[] }`. Validate every key against `STATUS_VOCABULARY` and
  require at least one.
- Add `setColumnStatuses` to `lib/server/service.ts` behind `project.config`.
- On the Configure screen, make the statuses cell a multi-select over the shared vocabulary.
- **The hard part, and the reason this needs care:** decide what happens to cells already
  holding a status the column no longer allows. Recommended — leave the stored value, let
  it render with its own tone, and show a warning count on Configure ("3 cells hold a
  status this column no longer allows"). Silently rewriting them destroys audit truth.
  Whatever you choose, write it down here and test it.

### 3.2 Column ordering

`DeliverableColumn.order_index` exists and is respected by `columnsFor()`. Nothing sets it
after the seed. Add reordering on Configure (up/down buttons are enough — do not add a
drag-and-drop dependency for this) and a route to persist it.

### 3.3 Create a module directly

`module.create` is defined, granted to Admin/Sub-admin/Release manager, and has **no route
and no UI**. Only cloning from the library adds a module. The Dashboard's "Add a module"
button currently points at the library as a stopgap.

- `POST /api/v1/modules` — node type (from the project's configured list) plus activity
  name; creates every cell blank.
- Reject a duplicate node-type + name pair in the same project: that pair *is* the module's
  identity.
- Decide whether creating a module should also create a library entry. The design says the
  library is "built once, then cloned", which implies yes — confirm with the user.

### 3.4 Edit subactivities

Add, rename, remove — covered by `module.edit`, no route or UI today. Note that removing
the last subactivity turns the module's row from derived back to directly editable, so its
cells must be materialised at that point or the row will read as all-blank.

### 3.5 Defect assignment

`defect.assign` is defined and granted to QA; `Defect.assignee` exists in the schema and is
always `null`; there is no UI. Assign from the defects table, choosing from the project's
configured owners.

### 3.6 Cleanup

`lib/server/service.ts` ends with a stray `export { isStatusKey }` re-export that nothing
imports. Delete it.

---

# Part 4 — The deferred product surface

Everything here is modelled but has no screen. Check scope with the user before building:
the design bundle explicitly defers some of it.

- **Create a project.** `project.create` has no route. CMDB and INVENTORY_SYNC are seeded
  as "not configured" and the switcher reaches them, but a project with no columns renders
  an empty matrix instead of a set-up prompt. At minimum, add that prompt — it is the first
  thing a second team would hit.
- **Project members screen.** `project.members.manage` is defined with nothing behind it.
  Membership rows already support org-wide (`project_id: null`) or per-project scope.
- **Mail transport.** Invitations work end to end — single-use expiring token, acceptance
  page, password set by the invited user — but there is no mailer, so the acceptance link
  comes back in the API response for an admin to copy. Wire to SMTP, or emit
  `user.invited` and let a consumer send it (see Part 6).
- **Project-wide audit screen.** `admin.audit.view` is granted, and the feed appears on the
  dashboard and module detail, but there is no searchable project-wide view.
- **Super admin** — organisation creation and first-admin onboarding. The model is built
  (`Tenant`, org-wide `Membership`). **The user explicitly deferred the screen.** Do not
  build it without asking.

---

# Part 5 — The Drift agent

The Drift screen renders and derives its verdicts correctly from the hashes it holds — but
those hashes are seeded. Nothing reports them. This is the largest genuinely new moving
part and the design bundle rightly puts it last.

**Read `../NEI_CONTEXT.md` before starting.** The agent must respect the platform as it is:

- **Java 8 and Python 2** on the servers. Not a typo, and not negotiable.
- **`.packinglist` is the source of truth** for what actually deploys.
- **Strict YAML binding** against the compiled bean.
- **~96 KB inline transport ceiling** — anything larger goes over SFTP.
- **Identity is content hash, never path.** The same file exists in many places with
  different contents; compiled artifacts go stale against source; the deployed copy drifts
  from the repo copy. A run must reference the exact hashes that executed.

Work:

- An ingest endpoint that upserts `DriftRow` per environment (repo / lab / preprod / prod).
- Derive the warnings instead of seeding them. `driftVerdict()` in `lib/server/service.ts`
  already derives the verdict; the four warnings are still fixtures in `lib/server/seed.ts`.
- Make the promotion gate real. It currently computes two of its four checks from live data
  (lowest module readiness, hash mismatch count) and hard-codes the other two as "pending".

---

# Part 6 — Production shape

None of this is needed for a pilot. All of it is needed before more than one person relies
on it concurrently.

- **Postgres.** The store is deliberately shaped for it — the narrow `cells` table ports
  row-for-row. Needs a schema, a repository seam behind `lib/server/store.ts`, and an
  importer. TMS's `packages/core/src/repos/sql/` is the reference for how they did it.
- **Concurrency.** Writes are serialised in one process. Two instances will lose writes.
  This is the real reason Postgres matters, not scale.
- **Redis** in front of `buildSnapshot` — one projection per project, invalidated on any
  write. That is exactly the cache the design calls for, and the code is already shaped as
  a single projection function to make it drop-in.
- **Kafka** — `cell.changed`, `module.closed`, `defect.raised`, `defect.transitioned`,
  `deployment.confirmed`, `user.invited`. Nothing is emitted today.
- **Refresh tokens.** Auth issues one 12-hour access cookie; there is no rotation and no
  revocation list. TMS's `packages/core/src/services/auth.service.ts` has the pattern.
- **Spring Boot back end.** The design targets Java; today the API is Next.js route
  handlers. The HTTP boundary is thin and the service layer is transport-agnostic, so the
  port is mechanical — but it is a real piece of work and has not been started.
- **E2E tests.** TMS uses Playwright; there is none here.
- **Accessibility audit.** Focus rings, `aria-pressed` and titles are in place. The matrix
  has not been checked with a screen reader, and its cells are buttons in a flex layout
  rather than a real `role="grid"` — that is the known weak point.

---

## Known deviations from the design bundle

Each was a judgement call. Revisit any of them with the user; do not silently "fix" one.

1. **"Sign in" is not a nav tab.** The prototype listed it as the tenth tab because one
   page had to show every screen. Here it is reached by not having a session, and its slot
   in the header is the signed-in user plus Sign out.
2. **"Raise RITM" is now "Check drift".** The prototype's button had no behaviour and no
   ticketing integration exists, so the slot goes somewhere real.
3. **Seeded accounts share the password `tracker`.** Development only; real accounts arrive
   by invitation and set their own.
4. **`Stage` and `ProjectConfig` replaced the per-entity `NodeType`/`Stage` tables** the
   design's data notes imply. The four Configure sets carry no data of their own, so they
   are ordered lists on one config record per project. Revisit if stages ever need fields.
