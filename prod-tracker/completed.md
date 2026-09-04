# Completed — Flow One Prod Tracker

App root: `tracker/prod-tracker/`. Standalone Next.js app; TMS is a **reference**, not a
dependency — nothing is imported from it and the TMS repo is untouched.

Last verified: build clean, typecheck clean, runtime smoke test passing.

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
