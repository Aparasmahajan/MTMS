# Completed — MTMS (Mahajan Ticket Management System)

App root: `tracker/mtms/`. Standalone Next.js app; TMS is a **reference**, not a
dependency — nothing is imported from it and the TMS repo is untouched.

Last verified: build clean, typecheck clean, runtime smoke test passing, `npm test` green
(141 tests).

> **Taking over this project?** Read [pending.md](pending.md) first — it is written to be
> read cold and carries the ground rules, the gotchas, and Parts 2–6 of the plan.

---

## Part 1 — foundation, all ten screens, file-backed store

### Domain layer (`lib/shared/`)

| File | What it holds | Status |
|---|---|---|
| `vocabulary.ts` | Status vocabulary (11 statuses, 4 tones), tone→style map, column status subsets, **roll-up rule**, **readiness**, **stage bucketing**, `nextStatus`. All pure. | done |
| `permissions.ts` | 17 tracker permission keys, labels, 5 groups, 7 seeded roles with grants, `resolveEffectiveAccess` / `hasPermission` / `unGrantablePermissions`. Shape copied from TMS `packages/shared/src/permissions.ts`. | done |
| `domain.ts` | Zod schemas. Reused from TMS: `Tenant`, `User`, `Role`, `Membership` (org-wide `project_id: null` or per-project), `Project`. New: `DeliverableColumn`, `ProjectConfig`, `Stage`, `Module`, `Subactivity`, `Cell`, `CellAudit`, `ModuleLibraryEntry`, `Defect`, `Link`, `Run`, `DriftRow`, `DriftWarning`, `Invitation`. | done |
| `views.ts` | Wire types (`Snapshot`, `ModuleView`, `CellView`, …) and `cellPresentation` so every screen renders a cell identically. | done |

Key decisions honoured:

- **Cells are a narrow table** — `(module_id, subactivity_id|null, column_key, status, changed_by, changed_at)` — never a wide row per module, because columns are user-configurable.
- **A module cell with subactivities is derived, never stored.** Refused by the API as well as disabled in the UI.
- **A blank is not a status.** `''` is a distinct value with its own tone and counts as a gap.
- **Nothing hard-codes the fourteen columns** above the seed.

### Server (`lib/server/`, `app/api/v1/`)

- `store.ts` — one JSON document, read once into memory, written back through a single serialised queue; atomic `write-temp + rename`. Version-stamped, reseeds on mismatch.
- `seed.ts` — the user's real sheet: 18 modules, 14 columns, 6 node types, 5 subactivity sets, 8 library entries, 5 defects, 5 audit entries, 7 drift rows, 4 warnings, 6 users, 7 roles, 2 invitations, 1 run with 5 phases and 5 artifacts. Deterministic ids, so a reseed is reproducible.
- `auth.ts` — scrypt passwords, HMAC-SHA256 JWT, single-use expiring invite tokens. **No native dependency**; `verifyAccessToken → Actor` is the only seam the rest of the app depends on, so OIDC can replace it without a route changing.
- `api.ts` — TMS-shaped boundary: `{ data, meta }` / `{ error: { code, message } }`, `withAuth`, per-user write rate limit, tenant read **only** from the token claim.
- `service.ts` — the projection and every mutation, each re-checking permissions server-side.
- `session.ts` — server components read the store directly (same projection, no extra hop); mutations always go over HTTP.

18 routes: login / logout / accept-invite · snapshot · project select · cells · module patch / fni / confirm-prod / links · link delete · defects create+transition · config columns add/patch/delete · config lists · library clone · role grants · invitations.

### Screens (`app/`)

All ten from `Prod Tracker.dc.html`, at the design's own token values:

1. **Sign in** — 400px blueprint card, both validation messages verbatim, the no-SSO footnote.
2. **Dashboard** — 4 clickable figures → filtered matrix, readiness by node type, "Nothing recorded" gaps card, closest-to-prod, recent changes.
3. **Defects** — phase chips, 3 count figures, blueprint log form, 8-column table, click-to-cycle status.
4. **Matrix** — 326/82/76/96px geometry, sticky header + sticky first column, node-type group headers, glyph cells, click-to-advance, subactivity expansion with `stopPropagation`, legend, both filter groups in the URL.
5. **Pipeline** — one column per configured stage, derived placement.
6. **Module** — FNI chain (5 steps), gated sign-off with the reason stated, target date, deliverables with audit stamps, subactivities, defects, links add/remove, change history, last execution, artifacts.
7. **Library** — clone into project, node type auto-added, redirect to the filtered matrix.
8. **Access** — hierarchy strip, invitation form with live permission preview, **writable** role×permission grid, users table.
9. **Drift** — hash comparison with the verdict **derived** from the hashes, warnings, promotion gate computed from live readiness.
10. **Configure** — column table (add / remove / toggle counts), four editable sets, status vocabulary, super-admin deferral note.

Plus `/accept-invite` — set-your-own-password from the invitation link.

### Design system (`app/globals.css`)

Industry tokens exactly as specified: colour ramps, Barlow / Barlow Condensed with a real
fallback stack, the 0.85× spacing scale, **square** cards/figures/buttons, the blueprint
frame with its four `+` registration marks, 2px accent `:focus-visible` everywhere, and
status carried by fill/outline/glyph only — no red/amber/green anywhere.

### Verified at runtime

| Check | Result |
|---|---|
| Snapshot projection | 18 modules · 14 columns · 5 defects · 7 roles · 17 permissions · 8 library · 7 drift rows |
| Readiness maths vs. the prototype | 3 fully in prod, 3 not started, 86 blank cells — matches |
| Roll-up | `128_TGRP…_CFX` 58%, 3 subactivities, module cells flagged `rolled_up` |
| Subactivity edit | advances, re-rolls the module cell, writes the audit stamp with who |
| Writing a roll-up cell | refused `400` |
| Closing FNI below 100% | refused `400` |
| Unknown column | refused `404` |
| Viewer writing a cell | refused `403`; viewer's permission set is exactly `project.view` |
| `JWT_SECRET` unset in production | server refuses to sign — as designed |

---

## Part 2 — tests

`npm test` (Vitest, node environment, `vitest.config.ts`). 56 tests across two files, plus a
harness. The service is tested directly rather than over HTTP: the route handlers only turn
a `ServiceError` code into a status, so going through them would test Next.js, not the rules.

| File | Covers |
|---|---|
| `lib/shared/__tests__/vocabulary.test.ts` | 22 tests. `rollUp` precedence (blank ▸ not-done ▸ in-progress ▸ done), that it returns a status a subactivity really holds, and that an unknown status reads as a gap. `readiness` including the 7/12 → 58% rounding. `stageIndex` at 0/1/49/50/99/100 across 2, 6 and 8 stages, with 100% proved to be the only percentage that reaches the last stage. `nextStatus` wrapping, the empty subset, and starting the cycle from a blank. |
| `lib/server/__tests__/service.test.ts` | 34 tests. The FNI gate (below 100%, at 100% with FNI not done, the open case, and that readiness is recomputed from the store rather than trusted). The roll-up guard, including a constructed disagreement between subactivities. Closed-module refusals and reopening. Viewer refused every mutation; DevOps may confirm prod but not sign off FNI. `toggleGrant` and `inviteUser` refusing to hand out more than the actor holds. `removeColumn` taking its cells and only in that project. `cloneFromLibrary` leaving the definition alone. |
| `lib/server/__tests__/harness.ts` | Seeds once per worker and caches the document as JSON — `buildSeed` hashes a password with scrypt, and doing that per test dominated the run. Each test gets a fresh copy at a temp path via `TRACKER_STORE_PATH` + `resetStoreCache()`. |

### The regression fixture

`describe('the seeded projection')` pins the known-good numbers: **18 modules, 14 columns,
3 fully in prod, 3 not started, 86 blank cells**, and `128_TGRP_CONFIGURATION_IN_CFX` at
**58%** with 3 subactivities and 4 blanks. Alongside them are three invariants that hold
whatever the seed becomes — EMAIL and RITM are the only columns out of readiness while still
carrying a cell on every module, every module buckets into one of the six stages with the
last reserved for 100%, and `missing` lists exactly the counted columns not at a done tone.

### Verified by mutation, not just by passing

A suite that has never failed has not been shown to work. Three deliberate faults were
introduced and each was caught, then reverted:

| Fault | Caught by |
|---|---|
| `rollUp` precedence reordered so not-done beats a blank | 2 unit tests + the service-level precedence test |
| `readiness` rounding up instead of to nearest | 1 unit test + the 58% fixture |
| The FNI gate no longer checking readiness | 2 gate tests |

The first fault initially escaped every service test, because all five seeded modules give
their subactivities identical rows — so the projection never had mixed tones to resolve.
`applies the precedence rule when subactivities disagree` was added to close that: it sets
one subactivity done, one not done and leaves one blank, and asserts the blank governs.

### A real bug the suite found

`writeToDisk` renames a temp file over the live store. On Windows that fails intermittently
with `EPERM` when a scanner or indexer holds the destination open for a moment — the suite
writes fast enough to hit it in roughly 40% of runs, failing a different random test each
time. `store.ts` now retries a transient `EPERM`/`EACCES`/`EBUSY` rename five times with a
short backoff. Losing that write would lose an audited status change, so this is worth
having in the app and not only in the tests. 12 consecutive runs green since.

---

## Part 3 — "generic without a code change", finished

The app was configurable in most respects but not all, and the unconfigurable parts were
the ones the design bundle is most emphatic about. 52 new tests (108 total), 3 new routes.

### 3.1 Editable column status subsets

`setColumnStatuses` behind `project.config`; `PATCH /api/v1/config/columns/[key]` now takes
`allowed[]` as well as `counts`. Every key is validated against the shared vocabulary —
`blank` is rejected, because a blank is the absence of a status rather than one.

**The decision, confirmed with the user:** cells already holding a status the column no
longer allows are **left exactly as they are**. Rewriting them would be a lie — the record
says a deliverable was loaded in prod, and an edit to a dropdown is not evidence that it was
not. Those cells keep their tone, still count toward readiness if that tone is done, and are
counted into a new `ColumnView.off_vocabulary` so Configure reports them in place: *"4 cells
hold a status this column no longer allows."* Clicking one moves it into the new subset,
because `nextStatus` starts the cycle over when the current status is not in the list.

### 3.2 Column ordering

`moveColumn` rewrites `order_index` densely across the project, so the sequence survives
however the columns arrived. Arrow buttons on Configure — no drag-and-drop dependency, as
the plan asked. Moving a column touches no cell: the reorder test asserts every module's
readiness is unchanged and its cells follow the new order.

### 3.3 Create a module directly

`POST /api/v1/modules` behind `module.create`. Node type must be one the project has
configured; every cell starts blank; the node-type + name pair is the module's identity, so
a repeat is refused with `409`, while the same activity name under a different node type is
two modules as intended.

**The decision, confirmed with the user:** a checkbox, default off, adds it to the library.
Direct creation is the exception path — the normal path is clone-from-library — so one-off
project modules do not silently populate the org-wide catalogue. Ticking it reuses a
matching entry rather than duplicating it.

The form lives on the **Library** screen, which makes the Dashboard's "Add a module" button
correct rather than the stopgap it was: this is where modules come from, and the "add to the
library" checkbox only makes sense next to the catalogue it adds to.

### 3.4 Edit subactivities

Add, rename and remove on the module screen, behind `module.edit`, with two structural
rules that the plan flagged and the tests pin down:

- **Adding the first subactivity** turns the module's row from stored into derived. Its
  existing cells are *moved onto* that subactivity rather than stranded, so a module that
  was 100% is still 100% the moment someone breaks it into parts.
- **Removing the last one** turns the row back, materialised from the roll-up as it stood a
  moment earlier — not from the removed subactivity's own row. A round trip through both
  directions leaves readiness and every status identical.

Add and remove are refused on a closed module, since both change the roll-up and therefore
the readiness the sign-off attested to. Rename is allowed, because it changes no status.

### 3.5 Defect assignment

`assignDefect` behind `defect.assign`, assigning from the project's configured owners so it
stays generic. A dropdown on the defects table; `null` unassigns. An owner removed from the
project since the defect was assigned is still shown, marked *(no longer an owner)*, rather
than the select silently misreporting who holds it.

### 3.6 Cleanup, and a second real bug

The stray `export { isStatusKey }` at the foot of `service.ts` is gone.

`parseBody` called `request.json()`, which **rejects on an empty body**. The defects table
cycles a status with a bodyless `PATCH`, so clicking one failed with *"Expected a JSON
body"* instead of advancing — a live bug on a shipped screen, missed in Part 1 because the
smoke test never clicked a defect status. An absent body now parses as `{}`, so a schema's
own optionality and defaults decide what a fieldless request means; a body that is present
but malformed is still a `400`.

### Verified over HTTP, not only through the service

The tests call the service directly, so the new routes were exercised against a running
server as well:

| Check | Result |
|---|---|
| Create module, `add_to_library: true` | `200` · readiness 0 · 14 blank cells · in library · 19 modules |
| Same node type + name again | `409` conflict |
| Add subactivity, duplicate name | `200`, then `409` |
| Rename, then remove the last subactivity | `200` · 0 subactivities · row no longer rolled up · 14 cells |
| FNI restricted to Completed | `allowed: [completed]` · `off_vocabulary: 4` |
| Status outside the vocabulary | `422` |
| Move CLICR up | `oh · clicr · filecr · nemo` |
| Move the first column up | `400` "already first" |
| Assign to a configured owner / to a non-owner | `200` / `422` |
| Bodyless defect PATCH (the fixed bug) | `200` · Open → Investigating · assignee kept |
| Viewer creating a module / editing column statuses | `403` both, naming the permission |

---

## Part 4 — the deferred product surface

33 new tests (141 total), 3 new routes, 1 new screen. **Super admin was not built** — it is
explicitly deferred and `pending.md` says not to build it without asking.

### 4.1 Create a project, and a set-up prompt

`createProject` behind `project.create`, `POST /api/v1/projects`, reachable from the project
switcher. The key is validated against `projectKeySchema` and uppercased; a duplicate in the
organisation is a `409`. No membership row is created — `project.create` is held org-wide
(`project_id: null`), which already covers every project including the new one.

A new project starts with **no columns, no node types, no stages**. It does not inherit
CR_AUTOMATION's fourteen, which is the whole claim of the app; there is a test asserting
exactly that.

The prompt the plan asked for: Dashboard and Matrix now render `<NotConfigured>` when a
project has no columns, instead of an empty grid that reads as breakage. Adding the first
column flips `Project.configured`, which is what the switcher reports and what turns the
prompt off. Pipeline already had an equivalent guard on stages.

### 4.2 Project members

`addProjectMember` · `setMemberRole` · `removeProjectMember` behind `project.members.manage`,
with a `members` projection carrying the reason a row cannot be edited. Three guards:

- **Nobody hands out more than they hold.** `requireGrantableRole` is the same rule that
  guards invitations, extracted so that adding a member cannot be used to route around it.
- **Organisation-wide access is listed but not editable from a project screen** — it applies
  everywhere, so changing it here would silently change every other project too.
- **Nobody can change or remove their own access**, checked before the role is validated so
  the refusal says the useful thing rather than complaining about the role.

It lives as a section on the **Access** screen rather than a tenth nav tab — see the
deviations note below.

### 4.3 A generalised audit trail

The gap that made 4.4 worth building: only cell changes were ever recorded, so "who created
this module", "who closed it" and "who dropped that column" were unanswerable. `CellAudit`
is now `AuditEntry` with a `scope` (`cell` · `module` · `project`), a nullable `module_id`
and a `label`. `STORE_VERSION` is **2**, so an existing store reseeds on next start.

One `record()` helper, called from every mutation that changes what the matrix shows:
deliverable changes and prod confirmations, module creation and cloning, owner and target
date, FNI closure and reopening, subactivity add/rename/remove, every column change, member
changes, and defect transitions and assignment. The messages are written to be read:
*"removed the last subactivity Deletion — the module row is directly tracked again, keeping
what it showed"*, or *"FNI statuses Pending, Completed → Completed — 4 cells keep a status no
longer in the list"*.

### 4.4 The audit screen

`/audit`, gated on `admin.audit.view`, with scope chips, a free-text search across what
changed / module / column / who, and a person filter. Reached from the dashboard's "Recent
changes → See every change", **not** from a new nav tab.

Filtering is client-side over the snapshot the screen already has: a project's history is a
few hundred rows. When that stops being true it becomes a paged endpoint and this filter
becomes its query — the comment in the file says so.

### 4.5 Mail transport — a seam, not a mailer

**Partial by necessity, and the limit is stated in the product.** There is one delivery seam
(`lib/server/mailer.ts`) and one call site. The default transport **logs and does not send**,
because this app has no mail server and silently failing to deliver would be worse than
saying so. `MAIL_TRANSPORT=webhook` + `MAIL_WEBHOOK_URL` posts the message to a relay — the
seam a corporate mailer or a Kafka `user.invited` consumer plugs into.

The invitation is committed *before* delivery is attempted and a delivery failure never
fails the request: the account and its single-use link already exist, so reporting "the
invitation failed" would be untrue. The acceptance link comes back either way, and the
Access screen now reports what actually happened — *"Invitation created. No mail transport is
configured, so nothing was sent. Send them this single-use link: …"*.

**Still needed from you: a real SMTP relay or webhook endpoint.** Nothing sends mail today.

### Verified over HTTP

| Check | Result |
|---|---|
| Create `radio_rollout` | `200` · key uppercased · 0 columns · 0 modules · switcher shows *not configured* |
| Duplicate key | `409` |
| Add the first column to it | `configured: true` · audit *"added the deliverable column Smoke test"* |
| Members of a fresh project | both org-wide, `editable: false`, reason stated |
| Add R. Kaur as Developer | `200` · editable · audit *"ACCESS — added R. Kaur as Developer"* |
| Add the same person again | `409` |
| Remove your own org-wide access | `400`, pointing at the Access screen |
| Invitation | `delivery_state: logged`, accept link returned |
| Audit feed after real changes | 8 entries — 1 project, 2 module, 5 cell — module labels resolved |
| `GET /audit` | `200` |
| Viewer creating a project | `403`, naming `project.create` |

---

## Part 4.5 — renamed to MTMS

The portal is **MTMS — Mahajan Ticket Management System**. Changed in the package name and
description, the browser title, the sign-in card, the invitation email, the development
JWT fallback, the test temp-directory prefix, and all three markdown files. The app
directory moved `tracker/prod-tracker/` → `tracker/mtms/`.

Deliberately *not* renamed:

- **`Flow One`** — the seeded tenant. That is the customer organisation, not the product,
  and it still reads as the org in the header and the switcher.
- **`../Prod Tracker.dc.html`** and the other design-bundle filenames. They are real files
  one directory up and the references have to keep resolving.
- **`prod` as a status, `prod.confirm` as a permission, "Loaded in prod"**. Those are the
  domain, not the brand.

141 tests and both builds pass after the rename.

---

## Part 4.6 — the static client demo

`npm run build:demo` writes `demo/` — 91 files, 6.2 MB, no Node server. Any static host
serves it; hand a client a URL and they can use the whole app.

### How it works

| Piece | What it does |
|---|---|
| `lib/demo/config.ts` | `IS_DEMO`, inlined from `NEXT_PUBLIC_DEMO` at build time, so the demo branch is dead code in a normal build. |
| `lib/server/demo-snapshot.ts` | Runs the **real** seed and the **real** `buildSnapshot` during `next build`, so the opening numbers are what the server would have sent — not a fixture. |
| `lib/demo/runtime.ts` | Answers every request in the browser. Shares the rules (`vocabulary.ts`, `withDerived`, `optimisticAdvance`) with the server; mirrors the permission checks; duplicates only the bookkeeping. |
| `lib/client/api.ts` | One `if (IS_DEMO)` at the single seam every screen already goes through, so no screen knows the difference. |
| `scripts/build-demo.mjs` | Parks `app/api` for the build (a static export cannot carry dynamic routes) and restores it in a `finally`; points the store at a temp path so nobody's local clicking gets baked into a client demo. |

### What a client can do in it

Everything except sign in: edit cells, expand subactivities, log and cycle defects, set
target dates, sign off FNI, clone from the library, add and remove columns, reorder them,
change what statuses a column takes, toggle role grants, invite, and walk the audit trail.
The header carries a **role switcher** — the same screens as DevOps or a Viewer, with the
controls disabling themselves and stating the reason.

### Verified in a browser against the built static site

| Check | Result |
|---|---|
| Dashboard opens on the seeded projection | 3 fully in prod · 12 part way · 3 not started · **86** blank cells |
| Click a blank NEMO cell | → *Not Created · P. Mahajan, just now* — advanced **and** stamped |
| Click a rolled-up module cell | opens its subactivities; does not edit |
| Navigate Matrix → Dashboard in-app | blank cells **86 → 85** — the edit propagated and every figure recomputed |
| Switch role to Viewer | matrix footer: *"You do not have update deliverable status (deliverable.update) in this project — cells are read-only for you."* |
| Normal `next build` after the demo work | still passes; 141 tests still pass |

### The one limitation

A static export has an HTML file per module, generated from the seed. A module **created
during the demo** has no page of its own, so `moduleHref()` sends it to the matrix rather
than to a 404 on the client's host. Everything else about that module — its row, its
cells, its readiness — is fully live.

---

## Part 5 — the Drift agent

Drift stopped being a screen with fixtures behind it. Hashes are now **reported per file,
per environment**, and every row, verdict, warning and gate is derived from them.

### The model

`DriftRow` is gone. In its place:

| Entity | What it is |
|---|---|
| `DriftObservation` | one file, on one environment, at one moment: path, **sha256**, size, `built_at` / `source_modified_at`, `in_packinglist`, who reported it and when |
| `DriftDeliverable` | which matrix column a file belongs to, and which of the four layers (java / python / yaml / config) it is |
| `DriftReport` | one agent submission, so "when did anyone last look at prod" has an answer |
| `DriftPromotion` | a promoted hash set, and whether prod has confirmed it |

Store version → **3**; a store written by an older build reseeds.

**Identity is `content_hash`; `path` is metadata.** A deliverable made of several files
gets a composite hash over the sorted `path\0hash` pairs, so changing any file in the set
changes the deliverable and the order files arrive in does not.

### Rules, each traceable to a real failure in `NEI_CONTEXT.md`

| Rule | The failure it catches |
|---|---|
| `Prod behind` | §7.3 — run 511's five false errors: prod ran an older build than preprod verified, and nothing in the output said so |
| `Patched in place` | servers agree with each other and not the repo — edited in place, so the next deploy silently reverts it |
| `Never verified` | §7.1 — no hash from prod at all. Raised **High** when the deliverable is shared, because a change there lands on every flavour |
| `Not deployed` | in the repo and on no server |
| `stale_compile` | §7.2 — a jar built before its source last changed. This is the "Cannot create property 'category'" day lost to blaming YAML indentation. Grouped per file, so one stale jar on four environments is one warning |
| `not_in_packinglist` | §9 — a file can be correct, committed, and never reach a server |
| `claimed_but_drifted` | the join that makes the screen matter: modules recording a deliverable as done in prod while its prod hash has drifted. *"Those cells are not evidence."* |
| `stale_report` | an agent that stopped reporting looks exactly like an environment that stopped changing — say which it is |

### The promotion gate

All five checks computed, none a placeholder, in `lib/shared/promotion.ts` so the static
demo recomputes the same rule. **A check that cannot be evaluated reads as closed, not as
unknown.**

`promoteDrift` records the promoted hash set and writes **no observation on the target**.
Promotion is an intent; only an agent report from prod turns it into a fact. Writing the
hashes forward would make the screen agree with itself and with nothing else — which is
the habit it exists to break.

### The agent — `agent/report_hashes.py`

Runs on each environment and posts to `POST /api/v1/drift/reports`.

- **Python 2.6+ and 3.** `optparse` not `argparse`, `urllib2` with a py3 fallback,
  `time.gmtime` not the deprecated `datetime.utcfromtimestamp`. The servers run py2 and
  `str()` on non-ASCII has already aborted a postcheck in production.
- **Streams in 64 KB blocks.** A comparison report is ~6 MB and the inline transport
  ceiling elsewhere is ~96 KB; nothing is read whole.
- **Reads `.packinglist`** for what actually deploys, and reports `in_packinglist` per file
  rather than guessing.
- **Never sends file content**, and excludes `mds.rc*` and `nemo_parameters.properties`
  outright — §7.7, those hold plaintext CMM/M2M/repo passwords.

Ingest authenticates with a bearer `DRIFT_INGEST_TOKEN` (agents have no session); a
signed-in user with `prod.confirm` may also post, which is what makes it testable by hand.

### Verified

28 new tests (**169 total**), plus an end-to-end run against the built server:

| Check | Result |
|---|---|
| Agent against a real package tree | 7 files, each classified to the right column and layer |
| `.packinglist` omission | the html template correctly reported `in_packinglist=false` |
| `mds.rc.add` (holds passwords) | never hashed, never named — confirmed absent from the payload |
| Agent → live app, valid token | `{"accepted":7,"ignored":[]}` |
| Agent → live app, wrong token | `401`, "This endpoint needs the drift ingest token." |
| Report prod+preprod identical, repo seeded | all seven → **Patched in place** |
| Then report the same tree as repo+lab | all seven → **In step**, warnings 16 → 1 |
| The one survivor | `not_in_packinglist` — exactly the finding that should survive |
| Gate after those reports | hash checks **PASS**; readiness and sign-off checks still **FAIL** correctly |
| Audit | `DRIFT — reported 7 hashes from lab by mtms-agent/<host>` |
| Promotion | writes no prod observation; stays unconfirmed; confirmed only by a matching report |

Also fixed while here: `scripts/build-demo.mjs` now retries `EBUSY`/`EPERM` on Windows,
the same way `store.ts` does.

---

## Part 6 — production shape

The single-process write limit is gone, the four production seams exist, and the Java port
has its first file. **Nothing that needs a server — Postgres, Redis, Kafka, a browser, a
JDK — has been run**, because none of them is on this machine. Every such file says so at
the top, and `pending.md` lists them together.

### 6.1 Storage seam and optimistic concurrency · **done, and tested**

`lib/server/storage/` — `driver.ts` (the contract), `file-driver.ts` (default),
`postgres-driver.ts`, `schema.sql`. Store version → **4**.

The contract is one idea: **every read carries the revision it saw; every write states the
revision it expects to replace.** A driver refuses a stale write with `RevisionConflict`,
and `mutate()` re-reads and **re-runs the callback** against fresh data — so a concurrent
change lands *on top of* another rather than over it. Two instances can no longer lose
writes.

Postgres holds the document in one row with a `revision` column; the write is
`UPDATE … WHERE id = $1 AND revision = $4` and a zero row count is the conflict. That was
the staged choice: it buys the property that matters without rewriting every mutation.
What it does not buy is SQL over the data — `schema.sql` is that target, with the narrow
`cells` table, partial unique indexes enforcing that a module cannot hold both its own row
and subactivity rows, and a note on the three things still to decide (row-level security,
the missing surrogate key, migrations).

### 6.2 Redis cache · **written**

`lib/server/cache.ts`, in front of `buildSnapshot`. Two rules keep it honest:

- **The key carries the store revision**, so a stale entry is never asked for. There is no
  invalidation to get wrong.
- **The key carries the user**, because a snapshot contains that user's permissions and
  members list. Caching per project alone would serve an admin's view to a viewer — the
  classic way a cache becomes a security bug.

Without `REDIS_URL` it is an in-process LRU. A Redis that is down logs and falls through to
the store; it must never take the app down with it.

### 6.3 Kafka, as an outbox · **done, and tested**

`lib/server/events.ts`. All six events the design names are emitted:
`cell.changed`, `module.closed`, `defect.raised`, `defect.transitioned`,
`deployment.confirmed`, `user.invited`.

Publishing from inside a mutation would make "the cell changed" and "the event was
published" two facts that can disagree. So events are appended to the same document as the
change, in the same `mutate()`, and drained afterwards — the store write is the commit
point. A failed drain leaves the event pending; a double drain is possible, so **consumers
must be idempotent** and `id` is there for it. Partitioned by module, so one module's
changes stay in order.

### 6.4 Refresh tokens · **done, and tested**

`lib/server/sessions.ts`, plus `POST /api/v1/auth/refresh`.

Stored as a hash, so a leaked store cannot be replayed. Rotated on every use. The part
worth understanding is the **family**: each login starts one, each rotation extends it, and
a token presented *twice* revokes the whole family — two parties hold it and there is no
way to tell the legitimate client from the thief. Losing a session is the correct price for
that ambiguity.

The client refreshes transparently on a 401 and replays once, with a shared in-flight
promise so several simultaneous 401s cause **one** rotation rather than a self-inflicted
replay that would revoke the family.

### 6.5 Accessibility · **written**

The matrix is now a real `role="grid"`: `aria-rowcount` / `aria-colcount` over the whole
grid, `role="row"` with a running `aria-rowindex` that counts group headers and expanded
subactivities, `rowheader` on the sticky first column, `columnheader` on the header row and
`gridcell` throughout, plus `aria-expanded` on a module with subactivities. A screen reader
can now say "row 12 of 41, column 6 of 17" instead of reading a wall of divs.

### 6.6 Playwright · **written, not run**

`playwright.config.ts` and `e2e/matrix.spec.ts` — 12 specs over the journeys only a browser
can prove: sign-in validation, that a wrong password and an unknown account give the *same*
message, the grid roles, a cell edit propagating to the dashboard, a roll-up opening rather
than editing, filters surviving a reload, a viewer being refused **by the API** and not just
by the UI, the FNI gate, and drift.

Uses `npm run dev` deliberately: the session cookie is `Secure` in production, so a browser
on plain HTTP would drop it and every test would fail for the wrong reason.

`e2e/` is excluded from `tsconfig.json` so the build stays green without the package.

### 6.7 The Spring Boot port · **started**

`contracts/openapi.yaml` — the contract both implementations answer to, all 27 routes with
the rules written into the descriptions.

`services/api-java/` starts with `StatusVocabulary.java`, a port of
`lib/shared/vocabulary.ts`, and `StatusVocabularyTest.java`, the same truth table as the
TypeScript test case for case. That file is first because it is the only code whose
behaviour *must* be identical in both: two services may differ in every other way, but if
they differ about what 58% means the matrix stops being evidence. The rounding note is in
the source — `Math.round` half-up matches JavaScript, `HALF_EVEN` would not.

### Verified

**189 tests** (20 new), typecheck clean, server build clean, demo build clean.

| Check | Result |
|---|---|
| A conflicting write | callback re-runs against fresh data; the third attempt is what lands |
| Endless conflict | gives up after 5 rather than looping |
| A losing attempt's edits | discarded — the retry starts from the winner's document, not the dirty one |
| Cache key | changes per revision **and** per user |
| Refresh rotation | successor issued; the spent token refused |
| Replay | revokes the whole family, including the honest successor |
| Sign-out | revokes the family, not just the token in hand |
| Token at rest | a sha256, never the token itself |
| Events | recorded in the same write; partitioned by module |
| A broker that refuses | event stays pending with the error; the next drain publishes it |
