# Handoff: Flow One Prod Tracker (project CR_AUTOMATION)

## Overview

A web tracker for getting change activities into production. It replaces a DevOps
spreadsheet where each row is an activity on a node type and each column is a
deliverable that must exist and be loaded in prod. The app makes that matrix
editable, attributable (who changed what, when), and generic enough that other
Flow One projects (CMDB, INVENTORY_SYNC, …) can run their own process in it
without a code change.

The first release covers **one organisation (Flow One), one project
(CR_AUTOMATION)**. Multi-tenant provisioning (super admin) is designed for but
explicitly out of scope — see *Roles and access*.

## About the design files

`Prod Tracker.dc.html` in this bundle is a **design reference created in HTML** —
a prototype showing intended layout, copy and behaviour. It is **not production
code to copy**. It runs on a small in-house streaming component runtime
(`support.js`) and a design-system stylesheet; neither is part of the target
stack.

The task is to **recreate these screens in the target codebase** — Next.js on the
front end, Spring Boot on the back end (see *Target stack*) — using that
codebase's established patterns, and extending the existing TMS codebase rather
than duplicating it (see *Relationship to the existing TMS codebase*).

`NEI Tracker.dc.html` is an **earlier, superseded** exploration kept only for
history: it modelled individual executions as the unit of tracking. Do not build
from it. The module matrix in `Prod Tracker.dc.html` is the current model.

## Fidelity

**High fidelity.** Colours, typography, spacing, borders and interaction states
are final and come from the Industry design system (tokens listed under *Design
tokens*). Recreate the layouts closely, but source the values from the target
codebase's own token layer if it has one. Content in the prototype is real where
it came from the user's sheet (activity names, node types, deliverable columns,
statuses) and illustrative where it did not (owners, dates, hashes, defect text).

---

## Domain model

Read this before the screens; every screen is a view onto these entities.

### Module — the unit of tracking

A **module is a node type plus an activity**, and it is a **global entity within a
project**. `CFX + 128_TGRP_CONFIGURATION_IN_CFX` is one module;
`SBC + 128_TGRP_CONFIGURATION_IN_SBC` is a different module. Same activity on two
node types = two modules, tracked separately.

A module is also a **library entry**: built once, then cloned into a project.
Cloning copies the definition and starts fresh tracking; the library entry is
unaffected. A module can therefore exist in several projects at once, each with
its own status data.

Under a module:

- **Subactivities** — each with its own full deliverable row. Named from the
  activity itself, e.g. `5_ADDITION_DELETION_MODIFICATION_OF_SIP_FILTER_MM_IN_SBC`
  has *Addition*, *Deletion*, *Modification*. A module may have none, in which
  case its deliverable row is tracked directly.
- **Runs / executions** — identified by `CHILD_REQ_ID` (a bare integer), with
  phases and artifacts.
- **Defects** — raised against the module, in a named phase.

**Roll-up rule.** When a module has subactivities, the module's cell for a column
is derived, never stored: blank if any subactivity is blank; else not-done if any
is not-done; else in-progress if any is; else done. A module cell is therefore
read-only in the UI — clicking it opens the subactivities.

### Deliverable columns

Columns are **project configuration**, not code. The seeded set for CR_AUTOMATION,
in sheet order, with the user's own definitions:

| Column | Full meaning | Statuses it can take | Counts toward prod |
|---|---|---|---|
| OH | Order Hub entry created | Not Created / Created | yes |
| FILECR | NEI code for File CR | Not Loaded / Loaded in lab / Loaded in prod | yes |
| CLICR | NEI code for CLICR | Not Loaded / Loaded in lab / Loaded in prod | yes |
| NEMO | OM configuration so the BST workflow can call the NEI | Not Created / Created | yes |
| HTML | HTML report files for File CR and CLICR | Not Loaded / lab / prod | yes |
| JSON.Y | `json.yaml` template — shared by File CR and CLICR | Not Loaded / lab / prod | yes |
| VALID.Y | `validation.yaml` — File CR | Not Loaded / lab / prod | yes |
| EXEC.Y | `execution.yaml` — CLICR | Not Loaded / lab / prod | yes |
| BST | BST workflow logic | Not Loaded / Loaded | yes |
| LOOKUP | Business service logic / application properties for BST | Not Loaded / Loaded | yes |
| EMAIL | Email template | Not Loaded / Loaded | no |
| FNI | FNI — final submission | Pending / Completed | yes |
| ACCESS | Node access granted | Pending / Completed | yes |
| RITM | RITM raised | Not raised / Raised | no |

Admins can add, remove and re-scope columns. `counts` decides whether a column
enters the readiness percentage.

### Status vocabulary

One **shared vocabulary per project**; each column is configured with the subset it
may use. Every status carries a *tone* that drives both the visual and the maths.

| Key | Label | Tone | Meaning |
|---|---|---|---|
| `blank` | Not filled | blank | Nothing recorded. **A blank is not a status** — it means someone forgot, and the dashboard counts it as a gap. |
| `notcreated` | Not Created | none | |
| `created` | Created | done | |
| `notloaded` | Not Loaded | none | |
| `lab` | Loaded in lab | part | |
| `prod` | Loaded in prod | done | |
| `loaded` | Loaded | done | |
| `pending` | Pending | part | |
| `completed` | Completed | done | |
| `notraised` | Not raised | none | |
| `raised` | Raised | done | |

**Readiness** of a module or subactivity = `done` cells ÷ counted columns, as a
whole percentage.

### Node types

Configurable list: `MRF, DLU, SBC, EIR, CFX, DSR` seeded — more will come, so
never hard-code them. The node names in the prototype (`DRDLCFXA`, `lab01cci02`,
…) are illustrative; a node carries four non-interchangeable identifiers
(`NODE_NAME`, `HOSTNAME`, `niamID`, `UNIQUEID`) and any filter must state which
one it means.

### Pipeline stages

Configurable ordered list: `Not started, Code created, In UT, Lab / Preprod,
Moving to prod, Loaded in prod`. A module's stage is derived from its readiness
percentage bucketed across the configured stages — it is not stored.

### Handover and closure (the FNI rule)

The sign-off chain, in order:

1. Dev complete, handed to testing.
2. Testing signs off on lab / preprod.
3. DevOps confirms **every deliverable is loaded in prod**.
4. FNI final submission raised (the FNI column reaches Completed).
5. **PM marks FNI done** — this closes the module and its subactivities.

**Gate, enforce server-side:** step 5 is only permitted when readiness is 100%
*and* the FNI column is `done`. Until then the control is disabled and states the
blocking reason. Closure means "our part is complete"; tracking ends there.

The PM also sets an **FNI target date** per module — the target date for prod
loading. It surfaces as the matrix `Target` column.

### Defects

Raised against a module, in one of three phases: **Staging test**, **Preprod
test**, **Prod deployment**. Fields: phase, module, ticket key, `CHILD_REQ_ID`
(optional), severity (High / Med / Low), description, raised-by, status
(Open → Investigating → Fixed). The ticket key links out to the ticket system —
defects are not a second ticket store.

### Audit

Every deliverable cell change records who and when, shown as a stamp on the cell
(hover title), a per-module change history, and a project-wide recent-changes
feed. This is a hard requirement: the sheet's core failure was that nobody could
tell who had set a value or whether a blank meant "not done" or "not recorded".

---

## Roles and access

Hierarchy:

| Level | Who | Can |
|---|---|---|
| Platform | **Super admin** | Creates organisations and onboards their first admin. Never touches project data. **Out of scope for this release** — build the model, not the screen. |
| Organisation | **Admin** | Owns one or more projects, onboards sub-admins, defines roles and their permissions. |
| Delegated | **Sub-admin** | Same powers as the admin or a narrower set — the admin decides per role. |
| Project | **Custom roles** | Any mix of permissions. |

Roles are per organisation, editable, and seeded as: Admin, Sub-admin, Release
manager, DevOps, Developer, QA, Viewer. The permission keys used by the Access
screen, grouped as the grid groups them:

```
project.view  project.create  project.members.manage  project.config
module.create  module.edit  module.clone  deliverable.update
prod.confirm  fni.date  fni.signoff
defect.create  defect.transition  defect.assign
admin.users.manage  admin.roles.manage  admin.audit.view
```

Seeded grants (the prototype's defaults):

- **Admin** — everything.
- **Sub-admin** — everything except `project.create` and `admin.roles.manage`.
- **Release manager** — project.view, all module.*, deliverable.update,
  prod.confirm, fni.date, fni.signoff, all defect.*, admin.audit.view.
- **DevOps** — project.view, deliverable.update, prod.confirm, defect.create,
  defect.transition.
- **Developer** — project.view, deliverable.update, defect.create,
  defect.transition.
- **QA** — as Developer plus defect.assign.
- **Viewer** — project.view only.

**Authentication: email and password only.** No SSO in this release. No
self-sign-up — accounts are created by invitation from an admin or sub-admin with
`admin.users.manage`; the invited user sets their own password from the emailed
link. Membership scope is either organisation-wide or a named list of projects.

---

## Screens / views

Ten views, all in `Prod Tracker.dc.html`. Nav order matches this list.

### 0. Sign in

- **Purpose:** email + password authentication.
- **Layout:** centred card, 400px wide, 27px padding, on the page ground.
  Blueprint frame (1px hairline + four corner registration marks).
- **Components:** organisation name as a 12px uppercase kicker with .14em
  tracking; `Sign in` heading (32px condensed); two stacked labelled fields
  (`Work email` type=email, `Password` type=password), 13px label above a full
  width input; full-width primary button `Sign in`; a 12px footnote — "Email and
  password only — no SSO in this release. Accounts are created by invitation from
  a project admin; there is no self sign-up."
- **Validation:** empty email or password → "Enter your email and password."; an
  email without `@` → "That does not look like an email address." Errors render
  as 12px text with a 2px left rule in the ink colour. Success navigates to
  Dashboard.

### 1. Dashboard — "Prod readiness"

- **Purpose:** where the project stands, and what is not recorded.
- **Layout:** max-width 1500px, 27px padding. Title block + two action buttons.
  Then a four-cell figure strip (equal columns, 1px dividers, single hairline
  border). Then a two-column body, `1.25fr / 1fr`, 27px gap.
- **Figure strip** (each clickable, filtering the matrix): *Fully loaded in prod*
  (of N modules) · *Part way* (at least one deliverable short) · *Not started*
  (nothing in prod yet) · *Blank cells* (no status recorded either way). Value is
  44px condensed 600, tabular numerals; label 12px uppercase .13em; note 13px.
- **Left column:** `Readiness by node type` — one row per node type: name (17px
  condensed uppercase), module count, a 10px progress bar, and the average
  percentage right-aligned. Clicking a row opens the matrix filtered to that node
  type.
- **Right column:** `Nothing recorded` — a blueprint card explaining that a blank
  cell is not a status, over four counted gaps (blank cells, modules with no
  target date, modules with no owner, modules with no RITM). Then `Closest to
  prod` — the five part-way modules by descending readiness, each with node-type
  tag, name, percentage and a "missing X, Y, Z" line. Then `Recent changes` — the
  six latest cell changes as column · what · who.

### 2. Defects

- **Purpose:** log and track what went wrong, in any phase.
- **Layout:** title block with phase filter chips (`All`, `Staging test`,
  `Preprod test`, `Prod deployment`), three count figures (Open, Investigating,
  Fixed) on the right, a `Log a defect` blueprint form, then the table.
- **Form:** module select (300px), phase select (160px), `CHILD_REQ_ID` (130px),
  ticket key (180px, e.g. `CRAUT-2291`), severity select (120px), description
  (flexes, min 240px), primary `Add defect`. Enter in the description submits.
  New defects land at the top with status Open and "P. Mahajan, just now".
- **Table columns:** Severity (filled tag: High = ink, Med = accent tint, Low =
  outline) · Phase · Module · Ticket (link to the ticket system) · Run ·
  What happened · Raised by · Status. **Clicking a status cycles** Open →
  Investigating → Fixed; that is stated in a caption under the table.

### 3. Matrix — "Module matrix"

The centre of the app. This is the spreadsheet, made editable.

- **Layout:** full-bleed with 27px/20px padding. Title, then two filter groups
  (Node type: All + each configured type; Readiness: All, Loaded in prod,
  Partial, Not started, Has blanks), then a four-item legend, then the grid in a
  bordered scroll container capped at `74vh` (both axes scroll).
- **Grid geometry:** built as flex rows inside a container of computed min-width
  (`326 + 82 + 96 + columns × 76` px).
  - Sticky first cell, 326px: module name (12px, wraps) over a 11px line with the
    owner and, when it has subactivities, a clickable `+ n subactivities` /
    `− n subactivities` toggle in the accent colour. Sticky left, page-ground
    background so rows scroll under it.
  - Readiness cell, 82px: a 6px bar plus the number.
  - One 76px cell per deliverable column.
  - Target cell, 96px: the FNI target date or "not set".
- **Header row:** sticky top, `Module — node + activity` / `Ready` / one cell per
  column (11px uppercase, wraps, full name in the `title` attribute) / `Target`.
- **Group headers:** one per node type, accent-tinted, `NODE TYPE` + "N modules ·
  M fully in prod".
- **Cells:** a single glyph, centred — `●` done (accent fill, paper glyph), `◐`
  in progress (accent-200 fill, accent-800 glyph), `○` not done (transparent,
  hairline, neutral glyph), `?` never filled (transparent with a **full ink
  border** so gaps are conspicuous). Hover shows a 2px inset accent outline.
  The `title` attribute reads "<full column name> — <status>[ · rolled up from N
  subactivities, click to open them][ · who, when]".
  - **Subactivity cell click** advances the status through that column's
    configured subset and records the audit stamp.
  - **Module cell click** (when it has subactivities) expands the module instead
    — the value is a roll-up and must not be edited directly.
- **Subactivity rows:** neutral-100 background, name indented 34px with a `↳`,
  its own readiness bar and its own editable cells; the Target cell is empty.

### 4. Pipeline

- **Purpose:** the same modules placed by how far they have got.
- **Layout:** one equal column per configured stage (1px dividers). Column head:
  stage name (14px condensed uppercase) + count. Cards: node-type tag, readiness
  percentage, module name, and a dotted-top "missing …" line.
- Stage assignment is derived from readiness — see *Pipeline stages*.

### 5. Module (detail)

- **Purpose:** everything about one module.
- **Layout:** breadcrumb, title block (name; node-type tag, readiness + stage
  label, target date, an **owner select**), two buttons (`Raise RITM` secondary,
  `Mark loaded in prod` primary). Then a two-column body `1.1fr / 1fr`, 27px gap.
- **Left:** `Handover & closure` — the five-step chain as marker + label + who +
  done/pending, then the FNI target **date input** and the `Mark FNI done` /
  `Reopen activity` button. When gated, the button is at 45% opacity with
  `cursor:not-allowed` and a 12px reason line: "Blocked — DevOps has not
  confirmed every deliverable loaded in prod; FNI final submission is not
  complete". When closed, an accent-filled banner: "Closed — prod FNI signed off,
  our part is complete".
  Then `Deliverables` — one row per column: clickable status marker, full column
  name, the audit stamp ("who · when" or "no change recorded"), and the status
  label. Then `Subactivities` — name, bar, percentage, with a note explaining the
  roll-up. Then `Defects on this module`. Then `Links` — typed links (RITM, Jira,
  Repo, Run log, Report, Confluence) with add (type select + label + URL) and
  remove.
- **Right:** `Change history` (column · what · who) · `Last execution` with the
  five run phases (`PRE_NODE_HEALTH_CHECK`, `BACKUP`,
  `ACTIVITY_CONFIGURATION`, `POST_NODE_HEALTH_CHECK`,
  `ROLLBACK_CONFIGURATION`), step counts and durations · `Artifacts` (kind, path,
  size).

### 6. Library — "Module library"

- **Purpose:** browse modules built once and clone them into a project.
- **Table:** Node type (tag) · Activity · Version · Subactivities · Used in (N
  projects) · Here (`In this project` accent tint / `Not in this project`) ·
  action button (`Clone into project` / `Clone again`).
- **Clone** inserts the module into the current project with an empty deliverable
  row, adds its node type to the project's node types if missing, and navigates
  to the matrix filtered to that node type.

### 7. Access

- **Purpose:** the whole access model, in one screen.
- **Hierarchy strip:** four equal cells — Platform / Super admin, Organisation /
  Admin, Delegated / Sub-admin, Project / Custom roles, each with a one-sentence
  "can" line.
- **Onboard a user** (blueprint card): email, display name, role select, scope
  select (organisation-wide or a project), `Send invitation`. Under it, a live
  preview of what the chosen role grants ("N permissions: …, +M more"), then the
  invitation list: email, name, role tag, scope, state ("Invited, 2 Sep — not
  accepted" / "Accepted, 1 Sep").
- **Roles & permissions** (blueprint card): a grid, permissions down, roles
  across. One `<tbody>` per permission group with an accent-tinted group header
  row. Each permission row shows its label over its 11px monospace key. Cells are
  24px squares — `✓` accent-filled when granted, `–` outlined when not — and
  **clicking toggles the grant**.
- **Users in this organisation:** name, email, role tag, scope.

### 8. Drift

- **Purpose:** "Loaded in prod" is only true if the bytes on prod are the ones
  that passed preprod. This screen compares them.
- **Table:** Deliverable (+ change cadence) · Scope (per flavour / shared / File
  CR / CLICR / workflow) · Repo · Lab · Preprod · Prod hashes · Verdict (In step
  = accent tint, Prod behind / Patched in place / Never verified = ink fill).
- **Open warnings:** severity chip (ink) + text + where.
- **Promotion gate:** a blueprint card — "Promotion copies hashes; it never
  rebuilds" — over four checkbox rows, then a disabled `Promote — blocked by 1
  gate` bar.
- Rationale for this screen: the same file exists in many places with different
  contents, compiled artifacts go stale against source, and the deployed copy
  drifts from the repo copy. Identity must be **content hash, not path**, and a
  run must reference the exact hashes that executed.

### 9. Configure

- **Purpose:** everything a project admin sets — this is what makes the app
  generic.
- **Deliverable columns** (full-width blueprint card): a table of Column · What
  it is · Statuses it can take (outline tags) · Counts toward prod ·
  remove; plus an input + `Add column`.
- **Four editable sets** in a two-column grid, each a blueprint card with
  removable chips and an add field: Node types, Pipeline stages, Owners, Link
  types.
- **Status vocabulary** (full-width): every status as marker + label + tone
  description, noting that columns pick from this shared list.
- **Super admin** (full-width, dashed border): states that creating organisations
  and onboarding admins sits one level above, and is out of scope for this
  release.

---

## Interactions and behaviour

- **Navigation:** a single sticky header, `min-height:58px`, that **wraps to a
  second line** when the ten tabs do not fit. Active tab carries a 2px accent
  underline; hover tints accent-100. Left of the tabs: an org + project switcher
  that opens a 330px blueprint dropdown listing the organisation's projects
  (CR_AUTOMATION active; CMDB and INVENTORY_SYNC "not configured"; `+ New
  project`) and a footnote that organisations and admins live in the super-admin
  panel.
- **Cell editing** is a click-to-advance cycle through the column's configured
  statuses — no modal. Every advance writes an audit entry. In the real app this
  is an optimistic update against `PATCH /modules/{id}/cells`.
- **Expansion** of a module's subactivities is local UI state; the expander must
  `stopPropagation` so it does not also open the module detail.
- **Gating** rather than hiding: controls the user cannot use are rendered at 45%
  opacity with the reason stated (`Mark FNI done`, `Promote`).
- **Focus:** `:focus-visible` is a 2px accent outline with 2px offset everywhere;
  never the browser default.
- **Responsive:** the matrix scrolls in both axes with a sticky header row and
  sticky first column. Two-column bodies should stack under ~900px. Phone use is
  read-plus-approve only (the user's stated need), so the matrix does not need a
  phone layout — the dashboard, defect logging and the FNI sign-off do.

## State

Per view: `screen`, project-switcher open flag, `nodeType` filter, `readiness`
filter, `phase` filter, expanded-module set, selected module id.

Persistent (server) state: deliverable cell values keyed by
`module[/subactivity]:column`; audit entries per cell; FNI target dates; FNI
closure flags; module owners; links; defects; project configuration (columns,
node types, stages, owners, link types, status vocabulary); roles, permission
grants, users, memberships, invitations.

## Target stack

- **Front end:** Next.js (App Router), TypeScript.
- **Back end:** Spring Boot (Java), REST.
- **Database:** PostgreSQL. The data is relational (modules, subactivities,
  columns, cells, audit, roles, memberships) and the matrix is read as a wide
  join — a relational store with proper indexes is the right default. Store cell
  values in a narrow table (`module_id, subactivity_id NULL, column_key, status,
  changed_by, changed_at`), never as a wide row per module, because columns are
  user-configurable.
- **Redis:** cache the assembled matrix per project (it is read constantly and
  written rarely), session/permission lookups, and rate limits.
- **Kafka:** publish domain events — `cell.changed`, `module.closed`,
  `defect.raised`, `defect.transitioned`, `deployment.confirmed`,
  `user.invited`. Consumers: notifications/email, the audit projection, and any
  future integration that watches for prod loading.
- **Auth:** email + password. Hash with bcrypt or Argon2. Invitation tokens are
  single-use and expiring. Enforce permissions **server-side on every request**;
  the client uses the same permission keys only to disable and explain controls.

## Relationship to the existing TMS codebase

The attached `TMS` folder already contains a Jira-like system with the same shape
of tenancy and the same intended stack (`apps/web` Next.js, `services/api-java`
Spring Boot). **Extend it; do not duplicate it.**

Reuse as-is from `TMS/packages/shared/src/domain.ts`: `Tenant`, `User`, `Role`,
`Membership` (already supports org-wide `project_id: null` or per-project scope),
`Project`. Reuse `TMS/packages/shared/src/permissions.ts` — its `PERMISSION_KEYS`,
`PERMISSION_LABELS` and `PERMISSION_GROUPS` are exactly the pattern the Access
screen renders; add the tracker's keys (`module.*`, `deliverable.update`,
`prod.confirm`, `fni.*`, `defect.*`, `project.config`) to that same array so one
vocabulary governs both apps.

New entities to add: `Module`, `Subactivity`, `DeliverableColumn`,
`StatusVocabularyEntry`, `Cell`, `CellAudit`, `ModuleLibraryEntry`, `NodeType`,
`Stage`, `Defect` (or map defects onto the existing `Issue` with a phase field and
a module reference — decide once, and prefer mapping onto `Issue` if its workflow
engine already gives you transitions and comments for free), and `Link`.

Defect ↔ ticket: a defect references a ticket key and links out. Do not copy
ticket bodies into the tracker.

## Build order

1. **Auth + tenancy.** Reuse TMS `Tenant`/`User`/`Role`/`Membership`. Add the new
   permission keys. Ship the Sign in screen and invitation acceptance. Nothing
   else works without this, and every later screen is permission-gated.
2. **Project configuration.** Deliverable columns, status vocabulary with
   per-column subsets, node types, stages, owners, link types. Build this
   *before* the matrix — the matrix is generated from it, and hard-coding the
   fourteen columns here is the one mistake that would undo the whole point.
3. **Modules and subactivities**, with the library and cloning.
4. **The matrix.** Cells, the click-to-advance cycle, the roll-up rule, audit
   stamps. This is the screen people will live in; get its read performance
   (Redis-cached projection) and its write attribution right.
5. **Dashboard**, derived entirely from 2–4. No new data.
6. **Handover and closure.** The FNI chain, target dates, and the server-side
   gate on closing.
7. **Defects**, with phases and ticket links. Emit Kafka events.
8. **Access screen** — the role/permission grid and user onboarding, on the model
   from step 1.
9. **Pipeline**, derived from readiness. Cheap once 4 exists.
10. **Drift.** Needs an agent that reports content hashes per environment; the
    largest new moving part and the right thing to leave last. Note the
    constraints it must respect: Java 8 and **Python 2** on the servers,
    `.packinglist` is the source of truth for what deploys, strict YAML binding
    against the compiled bean, and a ~96 KB inline transport ceiling (larger
    files must go over SFTP).
11. **Super admin** — organisation creation and admin onboarding. Explicitly
    deferred by the user.

## Design tokens

From the Industry design system (`_ds/industry-*/styles.css`).

**Colour**

| Token | Value |
|---|---|
| `--color-bg` | `#f2f2f3` |
| `--color-surface` | `#e9e9ea` |
| `--color-text` | `#1d1f20` |
| `--color-accent` | `#5980a6` |
| `--color-divider` | `#1d1f20` at 16% |
| neutral 100–900 | `#f5f5f8 #e7e7ea #d4d4d7 #b7b7ba #98989b #7a7a7d #5d5d60 #424244 #2b2b2d` |
| accent 100–900 | `#eef6ff #d6ebff #b5d9fd #94bce3 #749dc4 #597ea3 #416180 #2c455d #1d2d3d` |

Accent-on-ground is tuned to 3:1 — fine for chrome, icons and large text, not for
body copy. Use `--color-accent-700` for paragraph-size accent text. No decorative
colour beyond the steel accent: status is carried by fill, outline and glyph, not
by red/amber/green.

**Type** — Barlow Condensed 600 for headings, Barlow 400/500/700 for body.
`h1` 42px, `h2` 32px, `h3` 25px, `h4` 20px, `h5` 16px, `h6` 13px uppercase .08em.
Body 15px/1.55. Table and card body text 12–13px. Monospace
(`ui-monospace, Menlo`) for hashes, paths, emails, ids and run numbers.

**Spacing** — `3.4 / 6.8 / 10.2 / 13.6 / 20.4 / 27.2` px (a 0.85× density scale).
Use the scale, not raw numbers.

**Radius** — `2 / 4 / 7` px, but **cards, figures and buttons are square** in this
system. Do not round them.

**Shadow** — `sm 0 1px 2px`, `md 0 3px 10px`, `lg 0 12px 32px`, all ink-tinted;
used only for the project dropdown and dialogs.

**The blueprint frame** — cards, figures and primary containers wear a 1px
hairline border plus four `+` corner registration marks (11px, ink at 55%,
offset −6px). Cards stay transparent line drawings; the solid accent primary
button is the one filled object. Never drop the corner marks from a framed
element.

**Icons** — Lucide at stroke-width 1.5. The prototype uses text glyphs
(`● ◐ ○ ? ✓ – ↳ ▼`) for status; keep them as glyphs or replace with Lucide
equivalents at the same weight, but do not switch to colour-only indicators.

## Assets

None. No images or icon files; all marks are CSS or text glyphs. The design
system stylesheet is at `_ds/industry-e81e33a9-683c-4ebf-a5a4-a47e4fc446de/styles.css`.

## Files in this bundle

| File | What it is |
|---|---|
| `README.md` | This document. |
| `Prod Tracker.dc.html` | The current design — all ten screens. **Build from this.** |
| `NEI Tracker.dc.html` | Superseded run-centric exploration. History only. |
| `NEI_CONTEXT.md` | The engineer's write-up of the NEI/CLICR system the tracker sits over: the deployable package's four layers, `CHILD_REQ_ID`, the four node identifiers, the CIQ format, the observed production failures, and the platform constraints. Read this before building Drift or anything that touches artifacts. |

Note: the two `.dc.html` files reference `support.js` and the design-system
stylesheet from the project they live in, so they will not render standalone from
this folder. Read them as source; run them in the original project if you need to
see them live.
"# MTMS" 
