# MTMS — Mahajan Ticket Management System

A web tracker for getting change activities into production. It replaces the DevOps
spreadsheet where each row is an activity on a node type and each column is a deliverable
that must exist and be loaded in prod — made editable, attributable, and generic enough
that another Flow One project can run its own process in it without a code change.

Built from the design bundle one directory up: `../README.md` (the handoff),
`../Prod Tracker.dc.html` (the design), `../NEI_CONTEXT.md` (the system underneath).

**Progress lives in [completed.md](completed.md) and [pending.md](pending.md).**

## Running it

```bash
npm install
npm run dev
```

Then open <http://localhost:3100> and sign in as any seeded account with the password
`tracker` (development only):

| Email | Role | What it demonstrates |
|---|---|---|
| `parmahaj@nokia.com` | Admin | everything |
| `a.iyer@nokia.com` | Sub-admin | everything except creating projects and editing roles |
| `v.rao@nokia.com` | DevOps | deliverables and prod confirmation, no FNI sign-off |
| `r.kaur@nokia.com` | Developer | deliverables and defects only |
| `k.menon@nokia.com` | Viewer | read-only — every control disabled *and explaining itself* |

Signing in as the Viewer is the fastest way to see that permissions are real: the controls
render, state their reason, and the API refuses the write independently.

For `npm run build && npm start` you must set `JWT_SECRET` (see `.env.example`) — the app
refuses to sign tokens without it in production. Note the session cookie is `Secure` there,
so serve it over HTTPS or a browser will not keep the session.

## Tests

```bash
npm test
```

189 tests over the things worth pinning down: the pure rules in `lib/shared/vocabulary.ts`
— the subactivity roll-up, readiness, stage bucketing — the rules the server refuses to
break in `lib/server/service.ts`, chiefly the FNI gate and the permission checks, the drift
verdicts and their warnings, and the concurrency, session-rotation and outbox behaviour from
Part 6. A regression fixture holds the seeded projection to its hand-verified numbers, so a
rule change that would shift what the dashboard reports fails loudly.

What the tests do **not** cover is anything needing a server — Postgres, Redis, a Kafka
broker, a browser, a JDK. None is installed here, so that code is written and typechecked
but has never run. `pending.md` lists it under "Unverified".

## The static client demo

```bash
npm run build:demo
npx serve demo          # or drop demo/ on any static host
```

`demo/` is the whole app as plain files — no Node, no database, nothing to install. Hand a
client the URL and they can use it: edit cells, log defects, sign off FNI, clone modules,
add columns. A **role switcher** in the header shows the same screens as DevOps or a Viewer,
with the controls disabling themselves and saying why.

It is not a mock-up. The seeded projection is produced at build time by the real
`buildSnapshot`, and readiness, the roll-up and stage bucketing are computed by the same
`lib/shared/vocabulary.ts` the server uses, so the demo cannot show a number the real app
would not. What it does not share is persistence — nothing is saved, and a reload starts
over — and its mutation bookkeeping, which lives in `lib/demo/runtime.ts` and has to be
kept in step when a route is added.

One limitation: the export has an HTML page per seeded module, so a module *created* during
the demo has no detail page and its links fall back to the matrix.

## Drift, and the agent

"Loaded in prod" is only true if the bytes on prod are the ones that passed preprod. The
Drift screen compares them **by content hash, never by path** — the same script has been
found at five paths with five different contents.

Hashes are reported by an agent that runs on each environment:

```bash
python agent/report_hashes.py \
  --url https://mtms.internal --environment prod \
  --root /data/cloud-user/om/install/sas/bin/macro_server/java \
  --token "$DRIFT_INGEST_TOKEN" --project CR_AUTOMATION
```

Add `--dry-run` to print the report instead of posting it. The script is written for
**Python 2.6+ and 3** because the servers run Python 2, streams files in 64 KB blocks
because a comparison report is ~6 MB, reads `.packinglist` for what actually deploys, and
**never sends file content** — `mds.rc*` and `nemo_parameters.properties` hold plaintext
passwords and are excluded outright.

Everything on the screen is derived from those reports: the verdicts, the warnings, and a
five-check promotion gate. Nothing is stored pre-computed, so a fresh report changes all of
it. Where no agent has reported, the screen says so rather than showing agreement it cannot
vouch for — and a gate check that cannot be evaluated reads as *closed*, not as unknown.

Promotion records the hash set that should now be on the target and writes **no observation
there**. Only an agent report from prod turns an intent into a fact.

Set `DRIFT_INGEST_TOKEN` to accept agent reports; see `.env.example`.

## The store

One JSON document at `data/tracker.json`, seeded on first run from `lib/server/seed.ts`.
**Delete the file to reseed.** Writes go through a single serialised queue and land via
`write-temp + rename`, so a crash cannot truncate it.

Concurrency is optimistic rather than exclusive. Every read carries the revision it saw and
every write states the revision it expects to replace; if another process got there first,
the mutation is **re-applied against fresh data** rather than overwriting. So a callback
passed to `mutate()` must be safe to run more than once.

Set `DATABASE_URL` and the document moves to Postgres with the same guarantee — the write
becomes `UPDATE … WHERE revision = $expected`. That is the staged move: it buys
multi-process safety without rewriting every mutation. `lib/server/storage/schema.sql` is
the relational target for the rest. **The Postgres path has never been run** — there is no
database on the development machine; see `pending.md`.

The shape is deliberately relational, ready to port to Postgres unchanged. In particular
cells live in a narrow table — `(module_id, subactivity_id, column_key, status, changed_by,
changed_at)` — never a wide row per module, because columns are user-configurable.

## What the code is arranged around

**A module is a node type plus an activity.** `CFX + 128_TGRP_CONFIGURATION_IN_CFX` and
`SBC + 128_TGRP…_IN_SBC` are two modules, tracked separately.

**A blank is not a status.** It means someone forgot. It has its own tone, renders with a
full ink border so it is conspicuous, and the dashboard counts it as a gap. That
distinction was the sheet's core failure and it is load-bearing throughout.

**A module cell with subactivities is derived, never stored.** Blank if any subactivity is
blank; else not-done if any is; else in-progress if any is; else done. The API refuses to
write one, so the derived value cannot drift from its parts.

**Columns are configuration, not code.** Nothing above `lib/server/seed.ts` knows the
fourteen seeded columns exist. Add one on Configure and it appears on the matrix, in the
readiness maths, on the module detail and in the audit — for every module.

**Permissions are enforced server-side on every request.** The client holds the same keys
only to disable controls and say why.

## Layout

```
app/
  (app)/            the ten authenticated screens
  api/v1/           28 route handlers, TMS-shaped { data, meta } / { error }
  login/ accept-invite/
  globals.css       Industry design tokens and the blueprint frame
components/         AppShell, TrackerProvider, primitives, screens/
lib/
  shared/           vocabulary · promotion · permissions · domain · views  (pure, both sides)
  server/           store · seed · auth · sessions · api · service · session · mailer
                    drift · cache · events · storage/{driver,file,postgres,schema.sql}
  client/           api · optimistic
  demo/             config · runtime      the static demo's stand-in server
agent/              report_hashes.py      hashes, from each environment
contracts/          openapi.yaml          the contract both back ends answer to
services/api-java/  the Spring Boot port, started at StatusVocabulary
e2e/                Playwright specs (needs @playwright/test)
```

`lib/shared/vocabulary.ts` is the file to read first: the roll-up rule and readiness live
there as pure functions, and the server enforces the FNI gate with the same code the client
renders the matrix with, so the two cannot disagree about what 100% means.

## Running it for real

| Variable | What it turns on | Without it |
|---|---|---|
| `JWT_SECRET` | **Required in production.** Signs the access token. | Refuses to start |
| `DATABASE_URL` | Postgres instead of the JSON file | The file store |
| `REDIS_URL` | Redis in front of the snapshot projection | An in-process LRU |
| `KAFKA_BROKERS` | Publishes the six domain events | They are recorded and logged |
| `DRIFT_INGEST_TOKEN` | Lets the drift agents report hashes | No agent can post |
| `MAIL_TRANSPORT` | Sends invitation emails | The link is returned to the admin |

The optional drivers (`pg`, `ioredis`, `kafkajs`) are loaded only when their variable is
set, and each throws a message naming the package to install rather than a
module-not-found stack. None of them is installed here.

Sessions are a short access token plus a rotating refresh token. Rotation is on every use,
and **a token presented twice revokes its whole family** — two parties hold it, and there is
no way to tell the legitimate client from a thief.

Domain events go through an outbox: they are written in the same store write as the change
that caused them, then drained. So "the cell changed" and "the event was published" cannot
disagree — but a drain can repeat, so consumers must be idempotent.

## The Spring Boot port

`contracts/openapi.yaml` is the contract both back ends answer to. `services/api-java/`
starts with `StatusVocabulary.java` — the roll-up, readiness and stage rules — because that
is the only code whose behaviour must be *identical* in both implementations. Two services
can differ in every other way; if they differ about what 58% means, the matrix stops being
evidence. Neither has been compiled.

## Relationship to TMS

TMS was read as a reference and nothing is imported from it; that repo is untouched.
Copied deliberately: the permission vocabulary's shape and `resolveEffectiveAccess`
semantics, the zod domain style, the `{ data, meta }` HTTP envelope with `withAuth`, and
`Tenant` / `User` / `Role` / `Membership` / `Project` — so a membership row means the same
thing in both apps and the two can be merged later without a translation layer.
