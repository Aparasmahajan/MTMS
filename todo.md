# MTMS — todo

Everything asked for on 9 and 10 September 2026, and what was built alongside it.

Written to be read by anyone, including someone new to the project. No prior conversation
needed.

**Where this is going.** MTMS started as one team's tracker for CR_AUTOMATION. It is now
becoming a product **any team can pick up** — and a product-management tool, not just a
status board. So anything still hard-coded to one team's way of working has to be found
and made changeable from a settings screen.

---

## 1. The shape of the product

```
Organisation  →  Project  →  Module  →  Sub-module  →  Sub-activity
```

Read it as: a company has projects. A project tracks work on modules. Each module has
sub-modules on it. Each sub-module can be broken into smaller sub-activities.

For CR_AUTOMATION that means:

- **Module** = `SBC`, `MRF`, `CFX` — what CR_AUTOMATION calls a node.
- **Sub-module** = `5_ADDITION_DELETION_MODIFICATION_OF_SIP_FILTER_MM_IN_SBC` — what they
  call an activity.
- **Sub-activity** = `Addition`, `Deletion`, `Modification` — the pieces of that activity.

Two things were settled on 10 Sept:

- **There is no grouping level between organisation and project.** Projects sit directly
  under the organisation. (I started building a "tag" level and removed it again. Noted
  here so nobody rebuilds it by mistake.)
- **Modules are chosen per project**, by that project's admin. This already works today.

### The words in the code do not match

The code uses different names. This has to be fixed, and it touches most files.

**Done in the Java service and its UI on 11 Sept** (see section 4); still to do in
`mtms-static`.

| It used to say | It says now | What it is |
|---|---|---|
| `node_type` — a text label | `Module` | A record of its own now, so a checklist, owners and a discussion can hang off it |
| `Module` — a node + activity pair | `SubModule` | One row on the matrix |
| `Subactivity` | `SubActivity` | The pieces of one activity |

**Also needed: every project picks its own words.** CR_AUTOMATION says "node" and
"activity". Another team will say something else entirely. So a project stores the names it
wants for these three levels, and the screens show those names — instead of the words being
written into the code.

---

## 2. Already done

### Per-environment columns (9 Sept)

**The problem.** A deliverable gets loaded onto lab, then preprod, then prod. But these are
not really a sequence. Prod can be loaded when lab was never loaded, because lab was down
when the release window opened. The old design had one status per deliverable, so it could
not record that.

**The fix.** Each deliverable now has one column per environment, grouped under one header.
The matrix went from 14 columns to 26.

- **Only the prod column counts toward the readiness percentage.** If lab counted, a
  release that skipped lab could never reach 100%, and its final sign-off could never
  happen.
- An environment can be **switched off** on the Configure screen. Its columns leave the
  grid and leave the percentage. **Nothing is deleted** — every tick is kept, and switching
  the environment back on brings them all back exactly as they were. Prod cannot be
  switched off.

Built in all four versions of the app.

### Super admin console works in the demo (10 Sept)

**The problem.** The offline demo used to refuse anything to do with the admin console. So
the one part of the product you could not show a client was the part that sets everything
up.

**The fix.** The demo now keeps a full copy of every project, not just one. So a project
created in the console is a real, empty project you can open, configure and fill in.

- Switching between projects works. It used to allow CR_AUTOMATION only.
- **A project can have many admins, and one admin can have many projects.** Both already
  worked in the data; what was missing was a way for the super admin to set it up. That
  matters for a brand-new organisation, where nobody is inside it yet to do the setup.
- Removing an organisation-wide admin from a single project is blocked, because that access
  covers every project — clicking it on one row would quietly remove far more.

Checked properly in the built demo: created `BILLING_SYNC` → made Ritu its admin → opened
it → added a column and a node type → the matrix appeared.

### The team is in the seed data (10 Sept)

A job title and a role in the app are not the same thing. This is how they were matched up:

| Person | Role in the app | Their job |
|---|---|---|
| Nitin | Admin **+ super admin** | Runs the platform. Super admin is set on the account, not given by a role |
| Anand | Admin | Technical manager |
| Sanjay, Ritu | Release manager | PMs. This role runs modules, prod confirmation and sign-off |
| Vinayak, Muskan | QA | Test manager, and the SME who reviews with them |
| Paras, Bhavnish | Developer | |
| Dhruv | Viewer | Intern — can see everything, can change nothing |
| Narayana | DevOps | Confirms what is loaded in prod |

Emails are `firstname@azalio.io`. The demo signs in as Nitin so the console is reachable.

Two choices worth knowing about, both easy to change: **Dhruv is a Viewer**, not a
Developer — an intern who cannot change anything also happens to show off the permission
system nicely. And the demo starts signed in as **Nitin**.

---

## 3. Steps — the main new feature

**In one sentence:** a reusable checklist that the admin builds once and then attaches to
whichever modules and sub-modules need it, where only the right role can tick each item.

### How it is put together

There are three separate things. Keeping them separate is what makes the checklist
reusable.

**1. The step library** — the admin writes each step once.

| Step | Who is allowed to tick it |
|---|---|
| Received CIQ | SME or Product |
| Testing done | QA |
| All loaded in prod | DevOps |

**2. A configuration** — a named list of steps put onto one sub-module, in a chosen order.

The admin names it (`config1`, or anything clearer) and picks which steps go in it. A
different sub-module gets a different list. So:

- Sub-module A runs steps `1 → 2 → 3`
- Sub-module B, on the same module, runs steps `5 → 4 → 6`

**The order belongs to the list, not to the step.** The same step can be first in one
sub-module and third in another. This is why the order cannot be stored on the step itself.

**3. The record** — what actually happened. Who ticked it, when, every tick and un-tick
ever made, and the comments people wrote on it.

### Decisions made 10 Sept

| Question | Answer |
|---|---|
| Are steps the same thing as the matrix? | **No.** The matrix is the common checklist every sub-module shares. Steps are the specific process one use case follows. They live side by side and do not replace each other |
| Is a configuration reusable, or written per sub-module? | Written per module / sub-module. Each one gets its own list |
| Must steps be done in order? | **The admin decides, per configuration.** Some lists are a strict sequence, others can be ticked in any order |
| Can the admin add new roles? | **Yes.** Roles become something the admin sets up, not a fixed list in the code |
| What happens when a step is deleted? | **Soft delete.** It disappears from the screens, but its history and comments are kept |

Settled 11 Sept:

| Question | Answer |
|---|---|
| Which level does a checklist attach to? | **The lowest one that exists.** A module with no sub-modules holds it itself; once it has sub-modules, they hold it instead. Same rule the matrix already uses |
| And when an activity is split into sub-activities? | **On the activity by default.** An admin can push it down to the sub-activities for the ones that genuinely differ |
| What states can a step be in? | **Three** — not done, done, **blocked**. Blocked needs a written reason, otherwise it tells nobody anything |
| Who can tick, who can comment? | **Ticking is role-gated. Commenting is not** — anyone on the project can comment, stakeholders included |
| Can an admin tick for someone else? | **Yes, and the history records it as an override** — "Nitin ticked this on behalf of QA", never pretending QA checked it |
| Are owners real accounts? | **Yes.** An owner points at a person who can sign in. This is the only thing that makes notifications, @mentions and "my open steps" possible |
| Are discussions shared between projects? | **No, private to the project.** Same boundary the rest of the app keeps. People write freely when they know who is reading |
| What is the third level called? | **Sub-activity** — unchanged, to keep the churn down |
| What order do we build in? | **Settle the model, then write one MySQL schema in its final shape.** Nothing to migrate later |

### Still open

1. **Setting up 200 sub-modules by hand will not happen.** Needs a way to apply one list to
   every sub-module of a node at once, and a default list for newly created sub-modules.

2. **Nobody gets told anything.** If step 2 waits for step 1, someone has to notice step 1
   was ticked. A strict order makes notifications a requirement, not a nice extra.

3. **Too many settings is its own problem.** The app will soon have columns, environments,
   stages, steps, configurations and roles — all adjustable. A settings screen nobody can
   understand is how a flexible product loses the team that only wanted a checklist. Worth
   a deliberate pass on what to hide until it is needed.

---

## 3a. The model, written out

This is what the MySQL schema gets built from. Table names are what the code will use;
what the screens *call* them is set per project (section 1).

### The one big change: a module becomes a real thing

Today a node is only a piece of text on a row (`node_type = 'SBC'`). It has to become a
real record, because three of the new features hang off it: a module can hold a checklist,
a module can have owners, and a module can have a discussion. None of that can attach to a
piece of text.

| New table | Was | Holds |
|---|---|---|
| `modules` | `node_types`, a list of strings | `SBC`, `MRF`, `CFX` — one row each, per project |
| `sub_modules` | `modules` | `5_ADDITION_DELETION_...` — points at its module |
| `sub_activities` | `subactivities` | `Addition`, `Deletion`, `Modification` |

The matrix cells move with them: a cell is now `(sub_module, sub_activity, column)`.

### Steps

```
step_definitions          the library. Written once, used anywhere
  project, name, description, archived_at

step_definition_roles     who may tick it — several roles allowed
  step_definition, role                    ("Received CIQ" → SME, Product)

step_lists                one named, ordered configuration, attached to one thing
  project, name                            ("config1")
  target_type, target                      module | sub_module | sub_activity
  enforce_order                            admin's choice, per list
  archived_at

step_list_entries         which steps are in it, and in what order
  step_list, step_definition, order_index  ← the order lives HERE, not on the step

step_records              where each entry stands right now
  entry, state                             todo | done | blocked
  blocked_reason, changed_by, changed_at

step_events               every tick and un-tick ever made. Never deleted
  entry, from_state, to_state, by_user, at
  is_override, override_reason

step_comments             anyone on the project may write one
  entry, author, body, created_at, archived_at
```

Three points worth keeping in mind while building it:

- **The order is on `step_list_entries`, not on `step_definitions`.** That is what lets the
  same step be first in one list and third in another.
- **`step_records` is only a fast lookup.** `step_events` is the truth, and it is
  append-only. If they ever disagree, the events win.
- **Nothing here is ever hard-deleted.** `archived_at` hides a row; the history under it
  stays.

### Owners

```
owners
  project, scope_type, scope             module | sub_module | sub_activity
  role                                   empty = a general owner, not tied to a role
  user
```

Several rows means several owners. That covers all three of the things asked for at once:
different owners at different levels, owners per role, and more than one of each.

### Discussions

```
threads          project, scope_type, scope, topic, created_by, archived_at
thread_comments  thread, author, body, created_at, edited_at, archived_at
mentions         comment, user                  ← so people actually get told
```

### Per-project wording

```
projects
  + module_label            "Node"
  + sub_module_label        "Activity"
  + sub_activity_label      "Sub-activity"
```

Every screen reads these instead of having the words written into it.

---

## 4. The rest of the work

Roughly in the order that makes sense. Size is a rough guess.

### Move the database to MySQL · **done 11 Sept**

Verified against a real MySQL 8.0.40, not reasoned about. Docker is unusable on this machine
(the daemon runs, but pulling an image is refused — "Membership in the [nokiasam]
organization is required"), so `scripts/mysql-dev.sh` downloads the standalone server zip,
which needs no install and no admin rights. `./scripts/mysql-dev.sh schema` sets it all up.

Four things only a running server would have found:

1. **InnoDB refuses `ON DELETE CASCADE` on a column that a STORED generated column is built
   from.** All three NULL-folding columns are built from cascading foreign keys. They are
   `VIRTUAL` now, which InnoDB allows, and the reason is written in the schema so nobody
   tidies it back.
2. **Connector/J answers a `java.util.UUID` parameter by writing Java serialisation bytes**
   (`AC ED 00 05 ...`) into the column. It compiles anywhere, because `JdbcTemplate` takes
   `Object...`. Every query now goes through `Db`, a thin wrapper that converts the whole
   argument list, so there is no un-converted path left to reach.
3. **`LAST_INSERT_ID()` is per-connection.** The MySQL replacement for `RETURNING` read 0
   whenever the update and the select landed on different connections — every project would
   have shared cache key 0 and an optimistic-concurrency token that never moved. Both
   statements are pinned to one connection explicitly rather than relying on the caller
   being inside a transaction.
4. Assorted: `key` is reserved, MySQL cannot read the table it is inserting into from a
   `VALUES` subquery, and `= ANY (array)` has no MySQL equivalent (the allowed set travels
   as the JSON the column already stores).

**The JDBC layer had never been executed** — before these changes or after. It was written,
type-checked and reviewed, and every test ran against the in-memory repositories.
`JdbcRepositoriesMySqlTest` is the first thing that has ever run it: 12 tests covering the
JSON round trips, the UTC timestamp round trip, the node/sub-module split, cell upserts on
both the own row and a sub-activity's, and the revision counter. It skips rather than fails
where there is no database.

**58 tests pass** (46 domain + 12 integration).

### The MySQL move, as it was planned · reference

Prod is going to MySQL. The database code is currently written for PostgreSQL. Nothing here
is difficult, but all of it needs care.

| What | Now | On MySQL |
|---|---|---|
| ID columns | `uuid` | `CHAR(36)` — readable, and the code already handles it |
| Dates and times | `timestamptz` | `DATETIME(6)`, always stored as UTC. MySQL has no time-zone type, so the app has to convert on the way in and out |
| List columns (3 of them) | `text[]` | `JSON`, plus rewriting the small helpers that read and write them |
| "Insert or update" (8 places) | `ON CONFLICT … DO UPDATE` | `ON DUPLICATE KEY UPDATE` |
| Default timestamps | `now()` | `CURRENT_TIMESTAMP(6)` |
| One validation rule | `cardinality(allowed) > 0` | `JSON_LENGTH(allowed) > 0` — **this needs MySQL 8.0.16 or newer** |
| Text used in a unique rule | `text` | **Must become `VARCHAR(n)`.** MySQL cannot enforce uniqueness on unlimited text. Every unique rule needs checking |
| Database driver | PostgreSQL | MySQL connector, and the MySQL version of the migration tool |

**To decide:** rewrite the existing schema file for MySQL, or add a second one alongside
it? Rewriting is much cleaner if no PostgreSQL database is live yet — and none is.

### Rename the hierarchy · **done 11 Sept, in the Java service and its UI**

The code now uses the words in section 1. A row on the matrix is a **sub-module**, the thing
it sits on is a **module**, and the pieces below it are **sub-activities**.

What changed: about 1,000 names across the Java service and `mtms-frontend`, the JSON the
two exchange (`modules` → `sub_modules`, `node_type` → `module_name`, `subactivity_*` →
`sub_activity_*`), and the web addresses (`/api/v1/modules` → `/api/v1/sub-modules`, and the
page a person opens is now `/sub-modules/{id}`).

Two things were deliberately **not** renamed, because they are written into saved rows rather
than into code. Renaming them would be a change to existing data, and it buys nothing:

- **Permission keys** stay `module.create`, `module.edit`, `module.clone`. Only the words
  shown on screen changed.
- **Audit scopes and event names** stay `module` and `module.closed`.

**Checked properly, not assumed.** The service was started, signed into and driven through a
browser: the dashboard, the matrix with all 18 rows and 26 columns, and a sub-module's own
page all render from the renamed service with nothing in the browser's error log.

#### Three bugs this turned up, all in code the MySQL pass had reported as finished

These were real and would have stopped the application dead on its first request. They were
never caught because the tests written during the MySQL work checked each storage method on
its own and never checked **the read that builds a page** — which is assembled from seven
queries, and is exactly where a missed rename hides.

1. **Loading a project was never converted to MySQL.** It still asked for tables that no
   longer exist under those names. Every page in the application depends on it.
2. **Finding a project by its short key** was missing the quoting MySQL needs around the word
   `key`, which is reserved.
3. **The count beside each project in the switcher** counted modules where it meant to count
   sub-modules — so a project with twelve activities on one node read as 1.

Four tests now cover that composite read, including that one project's load cannot see
another's rows. **62 tests pass** (46 domain + 16 integration).

#### Still to do here

- **`mtms/` and `mtms-static/` still use the old words.** Both are self-contained — their own
  screens talk to their own code — so both still work correctly today. They are simply written
  in a different vocabulary from the service now. `mtms-static` is the one shown to clients,
  so it is worth doing; `mtms/` is the folder already marked for deletion, and renaming it
  before deciding that would be wasted work.
- **Each project picking its own words** is the other half of section 1 and is not started.
  The three columns exist in the database (`module_label`, `sub_module_label`,
  `sub_activity_label`); nothing reads them yet, so every screen still shows the built-in
  words.

### Discussions on modules and sub-modules · medium

A place to raise a topic and talk about it, attached to a module or a sub-module.

Worth adding at the same time:

- **@mentions.** A comment nobody is told about is a comment nobody reads.
- **File attachments.** CIQ documents, screenshots and logs are exactly what gets pasted
  into a chat today and lost tomorrow.

**To decide:** you said module and sub-module are a "global entity". Does that mean one
discussion shared across every project that uses the same node — so the SBC team learns
from another project's SBC work? That is powerful, but it lets information cross between
projects, which the app deliberately prevents everywhere else.

### Owners · medium

Today: one optional owner name per module, picked from a list of names.

Wanted (settled 15 Sept): **one overall owner, plus one owner per team.** So a module reads:

```
Overall owner    Paras Mahajan
Dev team         Bhavnish, Dhruv
QA team          Vinayak, Muskan
SME              Anand
DevOps           Narayana
```

The team rows are **not fixed**. The admin decides which teams a project has and what they
are called, in the same place they decide the roles (see *Roles per project*, below). A
project with no SME team simply does not show an SME row. Several people per row, at every
level, and a different set on the sub-module than on the module.

**Worth knowing:** owners are currently just typed-in names, not real user accounts. Making
them real accounts is the right move — it is what makes notifications and @mentions
possible — but it is a change to existing data, not just a new field.

### Roles per project · medium

Today: the roles are fixed in the code — admin, release, QA, dev, viewer, DevOps. Every
project gets the same six whether they fit or not.

Wanted:

- The admin can **add a role** to their project. A hardware team wants "Field Engineer"; a
  billing team wants "Revenue Assurance". Neither should have to ask us.
- The admin can **hide a role** the project does not use. If there is no QA team on this
  project, QA should not appear in owner lists, in the "who can tick this step" dropdown,
  or anywhere else. Hide, not delete — if the role was ever used, its history has to stay
  readable.

This is the same switch the owner teams read from, so build the two together.

### Change the module from the sub-module screen · small

Today, if a sub-module is filed under the wrong module, the only way to move it is to go
back to the matrix and change it there. That is two screens away from where you noticed the
problem.

Wanted: a module picker on the sub-module screen itself, so it can be moved in place.

### Counts per module on the landing page · small

After signing in, the landing page should show, for each module, **how many of its
sub-modules are live in production.** Something like `SBC — 12 of 19 in prod`.

The data already exists — production is just a column, and the app already counts ticks per
column. This is a new panel on a screen that exists, not new machinery.

### Remove the "recent changes" panel · trivial

Asked for on 15 Sept. It is being dropped from the screen it sits on.

### Bug: a new project did not appear in the app for up to ten minutes · **fixed 15 Sept**

Create a project in the super admin console and it showed there at once, but the project
switcher inside the app kept showing the old list.

**Why.** The app keeps a ready-made copy of each project's screen, and throws that copy away
whenever *that* project changes. Creating a **different** project changed nothing about the
one you were looking at, so your copy was still considered good — and the project list
happens to be part of it. It fixed itself when you next ticked anything, or after ten
minutes.

**Fixed by** marking every project in the organisation as changed, not just the new one.
Creating a project and granting or removing an administrator all do this now.

### Invitation links must stop disappearing · small

Noticed 16 Sept. When you invite somebody, the single-use link appears in a notice bar that
you can dismiss — and that vanishes the moment you do anything else on the screen. If you
close it before copying the link, **the link is gone for good.**

Not exaggerating: the server never stores the token, only a one-way hash of it, so there is
no screen and no database query that can ever show it again. The only repair is to delete
the pending invitation and issue a fresh one.

Wanted: for the super admin at least, issued links stay on screen until explicitly cleared
— a short list of "invitations issued in this session", each with a copy button, surviving a
page reload. Worth writing them to the browser's own storage so a refresh does not lose
them.

**Also worth doing at the same time:** a "reissue invitation" action, so a lost link is one
click rather than a delete-and-recreate.

### Bug: invitation links had the domain twice · **fixed 16 Sept**

The link read `https://mtms.azalio.iohttps://mtms.azalio.io/accept-invite?token=…` and did
not work.

**Why.** The server already builds a complete web address, using the `MTMS_APP_BASE_URL`
setting — that setting exists because the service sits behind a proxy and cannot see its own
public address. The screen then stuck the site address on the front of it a second time.

**Fixed by** using the server's address as-is.

### Changing who administers a project · **done 15 Sept**

The console could only ever *add* an administrator, and even that was broken against the
real server — the screen called for it but the Java service had no such route, so the button
did nothing in production. Now:

- **Assign** somebody to one project, or to every project in the organisation at once.
- **Remove** either kind. Organisation-wide access is removed from the organisation's own
  row, never from a project's — clicking × on a project row would otherwise take away every
  other project too, without saying so.
- Widening somebody to organisation-wide absorbs the single-project grants they held, so the
  same name never appears twice on a row.
- The last administrator of an organisation cannot be removed. Assign the replacement first.
- Somebody with no account yet is invited, and the single-use link comes back on screen.

This is administrator access — who can configure a project. It is **not** the module owner
work described under *Owners*, which is still to do.

### Parent and child columns on the Configure screen · small

Left over from earlier. `FILECR` with `LAB` / `PRE` / `PROD` underneath it exists only
because the starting data creates it that way. The Configure screen cannot make one. Needs
the screen and the code behind it to support creating a parent and adding children.

### Rebuild the module screen · medium

Shows what the matrix already knows, plus: a description the team can edit, custom fields
the admin defines, the step configurations, the discussion, and the full list of owners.

---

## 5. Ideas worth considering

You asked what else could make this one of a kind for product management. These are ordered
by how much I think each one is worth.

1. **Measure where the time actually goes.** Every tick is already stored with a timestamp.
   That means the app can say "CIQ sat waiting eleven days on average, testing took two" —
   **without anyone filling in a single extra field.** Most tools cannot answer this,
   because they rely on people updating estimates that nobody updates. This is the strongest
   candidate for the thing that makes the product different.

2. **Releases.** PMs think in releases — "the September drop" — not in individual modules.
   Group sub-modules into a named release and track it as one thing, with its own date and
   its own percentage. Right now a project is one long flat list.

3. **Project templates.** *The biggest thing for getting other teams to adopt it.* If every
   team has to set up 26 columns, node types, stages and checklists from nothing, most will
   give up in the first hour. CR_AUTOMATION becomes the first template. Creating a project
   then offers "start from a template, or start empty".

4. **Import from a spreadsheet.** This app replaces a spreadsheet, and every team that
   adopts it will be holding one. Importing a CSV turns a week of typing into an afternoon.

5. **Dependencies between sub-modules.** "147 cannot go until 5 is done." A basic
   product-management need that has no home in the app today.

6. **Notifications.** Email first, then Teams or Slack. Nothing currently tells anybody
   anything — there is not even a mail sender, only a link written into a log.

7. **Blockers, separate from defects.** A defect is a bug. A blocker is "waiting on a
   third party" or "no lab slot". They need different handling and a place on the dashboard.

8. **Status reports, generated.** A PM writes the same weekly update by hand every week.
   The history to generate it is already stored.

9. **Original date versus current date.** Keep the first target date as well as the current
   one, so slippage is visible instead of quietly rewritten.

10. **API tokens and a write API.** The drift agent already needs one. A build that ticks
    "testing done" by itself is worth more than any screen, because it removes the step
    where a person forgets.

11. **Saved views.** With each project configuring its own columns, the matrix gets wide. A
    saved, shareable filter — "my modules, not yet in prod" — makes it usable again.

### Notes for whoever builds this

- **Soft delete should apply everywhere, not just to steps.** The app is already careful
  never to destroy a record: hidden environments keep their ticks, narrowed columns keep
  their statuses. But **deleting a column still deletes all its cells** — the one place
  that principle is currently broken.
- **Changing a step's allowed role must not erase ticks already made.** Same reasoning: a
  settings change is not evidence that the work did not happen.
- **The offline demo is about to get expensive.** Every action has to be written twice —
  once for the real server, once for the demo. The features above roughly double the number
  of actions. Worth deciding now whether the demo keeps doing everything, or becomes a
  look-only showcase backed by the real API.
- **The `mtms/` folder is redundant.** It is the same as `mtms-static` apart from the demo
  layer. Deleting it removes a third of the copying work on every future change.
- **`mtms-static/services/api-java` is dead** and should be removed.

---

## 6. What happens next

The model is settled (section 3a). The order agreed on 11 Sept:

1. **Write the MySQL schema in its final shape** — new tables, renamed tables, steps,
   owners, discussions, per-project wording, all in one file. Nothing to migrate later,
   because nothing is live yet.
2. **Port the database code** to MySQL and get the tests green.
3. **Then build the features** into a database that already fits them.

### Nothing is blocking

Everything needed to start is decided. Two things will need an answer *during* the build,
but neither stops it starting:

- **Bulk set-up** (section 3, still open 1) — needed before a real team with 200
  sub-modules can use it, not before the schema is written.
- **Notifications** (still open 2) — a strict step order is much less useful without them,
  but the steps work fine on their own first.

### Worth agreeing before the schema is written

One small thing, easy to get wrong later: **does a project keep working if its admin
deletes a role that steps are gated to?** The rest of the app already answers this kind of
question the same way every time — the record stands, the configuration change does not
erase it. So: the step keeps its ticks and its history, and shows as *needing a role that
no longer exists* until an admin picks a new one. Say if you would rather block the role
from being deleted at all.
