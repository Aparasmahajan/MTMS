# Pending — Flow One Prod Tracker

**Handoff document.** Written to be read cold, with no prior conversation. Parts 1–3 are
built, run and are verified, and Part 4 is all but two items; Parts 5–6 are not started.

The part numbers are stable identifiers — a finished part keeps its number, so that every
cross-reference in this file and in the code comments keeps resolving.

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
npm test             # 141 tests — run this before and after any change to the rules
```

Sign in `parmahaj@nokia.com` / `tracker` (Admin), or `k.menon@nokia.com` / `tracker`
(Viewer) to see permission gating.

### Where things are

```
lib/shared/     vocabulary · permissions · domain · views   ← pure, imported by both sides
lib/server/     store · seed · auth · api · errors · service · session
lib/client/     api · optimistic
lib/**/__tests__/   vocabulary · service · columns · modules · projects · audit · api
                    plus harness.ts   ← npm test
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
- **A new rule needs a test in both places**: the pure function in
  `lib/shared/__tests__/vocabulary.test.ts`, and its effect on the projection in
  `lib/server/__tests__/service.test.ts`. A rule proved only in isolation can still be
  wired up wrongly — that is exactly what the roll-up precedence case showed.

### Gotchas that will cost you an hour each

- `tsconfig.json` sets **`noUncheckedIndexedAccess: true`**. `array[0]` is `T | undefined`.
- **Next.js page files may only export a default component** plus Next's own config
  exports. Exporting a helper from `app/**/page.tsx` fails the build.
- **`JWT_SECRET` is required in production.** `npm run build && npm start` without it
  returns 500 on login — by design, in `lib/server/auth.ts`.
- **The session cookie is `Secure` in production**, so `next start` over plain HTTP will
  not keep a browser session. Use `npm run dev` locally.
- **Delete `data/tracker.json` to reseed.** Bumping `STORE_VERSION` in `lib/server/store.ts`
  forces the same thing on next start. It is at **2** — `cell_audit` became `audit`.
- **Every mutation that changes what the matrix shows must call `record()`** in
  `lib/server/service.ts`. A change nobody can attribute is the failure this app exists to
  fix, and `/audit` is only as good as the calls into it.
- The store is a single JSON document held in memory with serialised writes. Correct for a
  pilot, wrong for more than one process — see Part 6.
- **`writeToDisk` retries the rename** on `EPERM`/`EACCES`/`EBUSY`. On Windows a scanner or
  indexer holding the destination open makes rename-over-existing fail intermittently. Do
  not simplify that back to a bare `fsp.rename` — it fails roughly 40% of test runs.

---

# Part 2 — Tests · **done**

56 tests, `npm test`. See [completed.md](completed.md) for what they cover, how they were
mutation-checked, and the Windows `EPERM` bug in `store.ts` they turned up.

What matters for the parts below:

- **Run `npm test` before and after touching a rule.** The regression fixture pins the
  seeded projection to hand-verified numbers, so a rule change that shifts what the
  dashboard reports fails loudly instead of quietly.
- Adding a service test: `beforeEach(useSeededStore)` from `lib/server/__tests__/harness.ts`
  gives a fresh store at a temp path. Look things up by name (`moduleId`, `roleId`,
  `libraryId`) rather than by seeded id. `refused(call, 'forbidden')` asserts the code and
  hands back the error so you can check the message the user would actually read.
- To set up a case the seed does not contain, `mutate()` the store directly in the test —
  `refuses to grant a permission the actor does not hold` does this to strip a permission
  from the admin's own role.
- **The seed under-covers the roll-up rule**: all five modules with subactivities give them
  identical rows, so the projection never resolves mixed tones. `applies the precedence rule
  when subactivities disagree` constructs that case. Keep it.

---

# Part 3 — "generic without a code change" · **done**

52 tests added (108 total), 3 new routes. See [completed.md](completed.md) for the detail,
including the second real bug the work turned up (`parseBody` rejecting an empty body, which
broke the defects table's status cycling).

Two decisions were taken with the user and are now load-bearing:

- **Editing a column's allowed statuses never rewrites cells.** A cell holding a status its
  column no longer allows keeps it, still counts toward readiness if its tone is done, and
  is counted into `ColumnView.off_vocabulary` so Configure reports it. Do not add a
  "clean up" path that rewrites them — the record of what was actually loaded is the one
  thing the app exists to protect.
- **Creating a module adds a library entry only when asked.** Direct creation is the
  exception path; the normal path is clone-from-library. The checkbox defaults to off.

Structural rules worth knowing before touching modules:

- Adding the **first** subactivity moves the module's own cells onto it; removing the
  **last** one materialises the module's row from the roll-up. Both directions preserve
  readiness — there are round-trip tests for it.
- Add and remove are refused on a closed module; rename is allowed, because it changes no
  status.

---

# Part 4 — The deferred product surface · **mostly done**

Project creation and the set-up prompt, project members, a generalised audit trail and the
`/audit` screen are built — see [completed.md](completed.md). Two things remain.

### 4.a Mail transport — a seam exists, nothing sends

`lib/server/mailer.ts` is the single delivery point. The default transport logs and does not
send; `MAIL_TRANSPORT=webhook` with `MAIL_WEBHOOK_URL` posts to a relay. **What is missing is
a real endpoint**, which needs the user's mail server or an internal relay URL — ask before
picking one. Wiring SMTP directly would add a dependency (`nodemailer`) and credentials
handling, and was deliberately not done on a guess.

The invitation is committed before delivery is attempted, and delivery failure must never
fail the request — the account and its single-use link already exist. Keep that.

### 4.b Super admin — **do not build without asking**

Organisation creation and first-admin onboarding. The model is built (`Tenant`, org-wide
`Membership`) and the Configure screen carries a deferral note. The user explicitly deferred
the screen, twice. Confirm before touching it.

### Worth knowing

- **Members are visible to anyone with `project.view`**, as the organisation user list
  already was. If that becomes a concern it is a projection change in `buildSnapshot`, not a
  screen change.
- **Audit filtering is client-side** over the snapshot. Correct for a few hundred rows;
  becomes a paged endpoint alongside the Postgres move in Part 6.

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
5. **Creating a module lives on the Library screen**, not the Dashboard. That is where
   modules come from, and the "add to the library" checkbox only means anything next to the
   catalogue it adds to. It makes the Dashboard's "Add a module" button correct rather than
   the stopgap it was.
6. **Project members is a section on Access, and the audit log is a linked page.** Neither
   is a nav tab: the design bundle's nine tabs are the shape of the app, and adding tabs for
   things you look up rather than work in would dilute it. `/audit` is reached from the
   dashboard's "Recent changes"; members sit under the org-wide access they qualify.
