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
Organisation  →  Project  →  Module (a node)  →  Sub-module (an activity)  →  Task
```

Read it as: a company has projects. A project tracks work on nodes. Each node has
activities on it. Each activity can be broken into smaller tasks.

For CR_AUTOMATION that means:

- **Module** = `SBC`, `MRF`, `CFX` — the node.
- **Sub-module** = `5_ADDITION_DELETION_MODIFICATION_OF_SIP_FILTER_MM_IN_SBC` — the activity.
- **Task** = `Addition`, `Deletion`, `Modification` — the pieces of that activity.

Two things were settled on 10 Sept:

- **There is no grouping level between organisation and project.** Projects sit directly
  under the organisation. (I started building a "tag" level and removed it again. Noted
  here so nobody rebuilds it by mistake.)
- **Node types are chosen per project**, by that project's admin. This already works today.

### The words in the code do not match

The code uses different names. This has to be fixed, and it touches most files.

| The code says | It really means | Note |
|---|---|---|
| `node_type` — just a text label | **Module** | Today it is only a grouping label, not a real thing in its own right |
| `Module` — a node + activity pair | **Sub-module** | This is one row on the matrix |
| `Subactivity` | **Task** | Needs a final name. "Step" is taken by the new feature below |

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

### Still to decide

1. **Can steps sit on a module, or only on a sub-module?** The examples are all
   sub-modules. If a module can have its own steps too, does it add them up from its
   sub-modules the way the matrix does, or keep its own separate list?

2. **Can an admin tick a step on someone else's behalf?** Someone is on leave and the
   release is stuck. If yes, the history must show it was an admin override — otherwise the
   record claims the right person checked it when they did not.

3. **Is a step just ticked or not ticked, or can it have other states?** Real checklists
   need **not applicable** and **blocked** — a step that cannot be ticked but is not
   outstanding either.

4. **Who can read the comments on a step?** The role controls who can *write*. Is reading
   open to everyone on the project?

5. **Setting up 200 sub-modules by hand will not happen.** Needs a way to apply one list to
   every sub-module of a node at once, and a default list for newly created sub-modules.

6. **Nobody gets told anything.** If step 2 waits for step 1, someone has to notice step 1
   was ticked. A strict order makes notifications a requirement, not a nice extra.

7. **Too many settings is its own problem.** The app will soon have columns, environments,
   stages, steps, configurations and roles — all adjustable. A settings screen nobody can
   understand is how a flexible product loses the team that only wanted a checklist. Worth
   a deliberate pass on what to hide until it is needed.

---

## 4. The rest of the work

Roughly in the order that makes sense. Size is a rough guess.

### Move the database to MySQL · medium

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

### Rename the hierarchy, and let each project pick its words · medium

See section 1. Two parts: rename `Subactivity` in the code once its final name is agreed,
and store per-project display names for all three levels.

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

Wanted: an owner on the module **and** a different owner on the sub-module; owners **per
role** (the dev owner, the QA owner, the DevOps owner); and **several owners** at any level.

**Worth knowing:** owners are currently just typed-in names, not real user accounts. Making
them real accounts is the right move — it is what makes notifications and @mentions
possible — but it is a change to existing data, not just a new field.

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

## 6. Open questions, shortest list

1. What is the third level called — task, item, action?
2. Can steps sit on a module, or only on a sub-module?
3. Can an admin tick a step for someone else, and how is that recorded?
4. Is a step only ticked / not ticked, or does it need "not applicable" and "blocked"?
5. Are discussions private to a project, or shared across projects using the same node?
6. Do owners become real user accounts now, or stay as typed-in names for the moment?
7. MySQL: rewrite the schema file, or add a second one?
8. What gets built first? MySQL blocks going live. Steps are the feature the product needs.
   They do not depend on each other.
