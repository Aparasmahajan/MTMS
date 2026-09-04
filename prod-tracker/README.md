# Flow One Prod Tracker

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

## The store

One JSON document at `data/tracker.json`, seeded on first run from `lib/server/seed.ts`.
**Delete the file to reseed.** Writes go through a single serialised queue and land via
`write-temp + rename`, so a crash cannot truncate it.

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
  (app)/            the nine authenticated screens
  api/v1/           18 route handlers, TMS-shaped { data, meta } / { error }
  login/ accept-invite/
  globals.css       Industry design tokens and the blueprint frame
components/         AppShell, TrackerProvider, primitives
lib/
  shared/           vocabulary · permissions · domain · views  (pure, both sides import it)
  server/           store · seed · auth · api · service · session
  client/           api · optimistic
```

`lib/shared/vocabulary.ts` is the file to read first: the roll-up rule and readiness live
there as pure functions, and the server enforces the FNI gate with the same code the client
renders the matrix with, so the two cannot disagree about what 100% means.

## Relationship to TMS

TMS was read as a reference and nothing is imported from it; that repo is untouched.
Copied deliberately: the permission vocabulary's shape and `resolveEffectiveAccess`
semantics, the zod domain style, the `{ data, meta }` HTTP envelope with `withAuth`, and
`Tenant` / `User` / `Role` / `Membership` / `Project` — so a membership row means the same
thing in both apps and the two can be merged later without a translation layer.
