# Pending — MTMS (Mahajan Ticket Management System)

**Handoff document.** Written to be read cold, with no prior conversation. Parts 1–6 are
built; Part 4 is all but two items. The rename to MTMS and the static client demo are done.

**What is verified and what is not.** Every rule is tested (189 tests). The Part 6
*drivers* are not: there is no Postgres, Redis, Kafka broker, browser or JDK on the
development machine, so that code is written, typechecked and reviewed but has never
executed. Each such file says so at the top. The list is under "Unverified" below — read it
before trusting any of it in production.

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
cd tracker/mtms
npm install
npm run dev          # http://localhost:3100
npm test             # 189 tests — run this before and after any change to the rules
npm run build:demo   # writes demo/ — the static client demo, no server needed
```

Sign in `parmahaj@nokia.com` / `tracker` (Admin), or `k.menon@nokia.com` / `tracker`
(Viewer) to see permission gating.

### Where things are

```
lib/shared/     vocabulary · permissions · promotion · domain · views  ← pure, both sides
lib/server/     store · seed · auth · sessions · api · errors · service · session · mailer
                drift · cache · events · demo-snapshot · storage/{driver,file,postgres,schema.sql}
lib/client/     api · optimistic
lib/demo/       config · runtime                            ← the static demo's stand-in server
lib/**/__tests__/   vocabulary · service · columns · modules · projects · audit · drift · api
                    plus harness.ts   ← npm test
components/     AppShell · TrackerProvider · primitives · screens/ModuleScreen
app/(app)/      page(dashboard) matrix defects pipeline modules/[id] library access audit drift configure
app/api/v1/     28 route handlers
scripts/        build-demo.mjs
agent/          report_hashes.py    ← runs on each environment, py2.6+ and py3
contracts/      openapi.yaml        ← the contract both back ends answer to
services/       api-java/           ← the Spring Boot port, started at StatusVocabulary
e2e/            matrix.spec.ts      ← Playwright; needs @playwright/test installed
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
9. **A new mutation needs a demo handler too.** `lib/demo/runtime.ts` is what the static
   client demo answers requests with. It shares the rules but duplicates the bookkeeping,
   so a route added on the server and not there makes the demo throw *"the demo has no
   handler for …"* — loudly, on purpose, rather than silently doing nothing. Run
   `npm run build:demo` and click the new control before calling a part done.

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
  forces the same thing on next start. It is at **4** — revision, refresh tokens, outbox.
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

# Part 5 — The Drift agent · **done**

28 tests, 2 routes, and `agent/report_hashes.py`. See [completed.md](completed.md) for the
detail and the end-to-end verification.

What matters before you touch it:

- **Identity is `content_hash`, never `path`.** Nothing may key on a path. A deliverable
  made of several files uses a composite hash over the sorted `path\0hash` pairs.
- **Promotion writes no observation on the target.** It records intent; only an agent
  report from prod confirms it. Do not "helpfully" copy the hashes forward — that makes the
  screen agree with itself and with nothing else.
- **A gate check that cannot be evaluated reads as closed, not unknown.** Promotion puts
  bytes on production; "we could not tell" is not a reason to let it through.
- **Absence of data must never render as agreement.** There is a test for exactly this
  (`never reads as In step on the strength of a missing prod hash`). Keep it.
- **The agent never sends file content**, and excludes `mds.rc*` and
  `nemo_parameters.properties`. Those hold plaintext CMM/M2M/repo passwords. An ingest that
  accepted content would pull them into the store and onto a screen.

### Still open in this area

- [ ] **`agent/report_hashes.py`'s `RULES` table is project-specific.** It maps a file on
      disk to a deliverable column, and it is the one place that knows that mapping. A
      second project needs its own table, or the mapping needs to move into project
      configuration and be fetched by the agent.
- [ ] **Nothing schedules the agent.** It is a script; it needs a cron entry or a hook in
      the deploy, per environment.
- [ ] **The `.packinglist` parser assumes the source path is the first whitespace-separated
      field.** That matched the observed file; confirm against the real one before relying
      on `in_packinglist` in anger.
- [ ] **`Run → Deployment` is still not built** — and `NEI_CONTEXT.md` §7.5 calls it "the
      join that matters and does not exist today". A run records `CHILD_REQ_ID` and phases,
      but nothing ties it to the exact hashes that executed. Drift now knows what is on each
      environment; runs still cannot say which of those they ran against. This is the
      single most valuable thing left in the whole plan.
- [ ] **Artifacts are not per-attempt** (§7.6). Run directories are reused across re-runs,
      so artifacts from different executions can mix in one tree.
- [ ] **The CIQ is not modelled** (§6). Nothing consumes `nodeGroups → configSequences →
      tables → records`, and the schema varies more than the CFX shape suggests.

---

# Part 6 — Production shape · **built, largely unverified**

See [completed.md](completed.md) for what landed. What matters before touching it:

- **Optimistic concurrency, not locking.** `mutate()` re-runs its callback against fresh
  data on a conflict, so **a callback must be safe to run more than once**. In practice they
  only touch the store they are handed; if you write one that has an outside effect, it will
  happen twice.
- **The cache key carries the store revision and the user.** Never widen it to the project
  alone: a snapshot holds that user's permissions, so a shared entry serves an admin's view
  to a viewer.
- **Events go in the outbox inside the same `mutate()` as the change.** Never publish
  directly from a mutation — the store write is the commit point, and consumers must be
  idempotent because a drain can repeat.
- **A replayed refresh token revokes its whole family**, including the honest successor.
  That is deliberate. Do not "fix" it by revoking only the presented token.
- **`e2e/` and `playwright.config.ts` are excluded from `tsconfig.json`** so the build works
  without the package. Install Playwright, then delete those two exclusions.

## Unverified — read before production

Everything here is written and reviewed but has **never executed**, because the dependency
is not on this machine. In rough order of how much it would hurt to be wrong:

- [ ] **`lib/server/storage/postgres-driver.ts`** — the SQL has never run. Point
      `DATABASE_URL` at a real database and confirm: first-write insert, the
      `UPDATE … WHERE revision` conflict path, and that `bigint` really does come back as a
      string from node-postgres.
- [ ] **`lib/server/storage/schema.sql`** — never applied. Apply it to an empty database and
      check the partial unique indexes actually forbid a module holding both its own cell
      row and subactivity rows.
- [ ] **The importer does not exist.** `tracker.json` → Postgres has not been written at all.
      Nothing migrates a pilot's data.
- [ ] **`lib/server/cache.ts` Redis path** — never connected. The in-memory path is exercised
      by every test; the `ioredis` branch is not.
- [ ] **`lib/server/events.ts` Kafka path** — never connected to a broker. The outbox,
      draining and retry *are* tested with a fake publisher; only `kafkajs` is untried.
- [ ] **`e2e/matrix.spec.ts`** — never run. Needs
      `npm i -D @playwright/test && npx playwright install chromium`. Expect the selectors
      to need adjusting on first run; they were written against the source, not a browser.
- [ ] **`services/api-java/`** — never compiled. No JDK or Maven here.
- [ ] **The optional packages are not installed**: `pg`, `ioredis`, `kafkajs`,
      `@playwright/test`. Each driver throws a message naming the missing package rather
      than a module-not-found stack, so the failure is at least legible.

## Still open in Part 6

- [ ] **The row-level Postgres port.** The staged decision was document-plus-locking now,
      tables later. Doing it properly means a repository per entity and rewriting every
      `mutate()` in `service.ts` — the largest single piece of work left. `schema.sql` is
      the target; TMS's `packages/core/src/repos/sql/` is the reference.
- [ ] **A migration tool.** The store reseeds on a version bump. Fine for a pilot, not once
      there is real data.
- [ ] **Row-level security.** Tenancy is enforced in the service layer and every query
      filters on `tenant_id`. RLS would make a missed filter fail closed instead of leak.
      Needs a per-request `SET LOCAL app.tenant_id` and a transaction-scoped pool.
- [ ] **Keyboard navigation in the matrix.** The roles and indices are right, so a screen
      reader can describe it; arrow-key movement between cells is not implemented, and a
      grid that announces itself but cannot be walked is only half done.
- [ ] **A real accessibility audit.** Nobody has run this with a screen reader. The roles
      are a considered guess, not a verified result.

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
