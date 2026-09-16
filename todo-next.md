# MTMS — what to do next

Written 16 Sept 2026, straight after the release that added steps, per-project wording and the
small pile (see `todo.md` §2a for what that was).

`todo.md` is the long record — every decision, why it was made, and what it cost. **This file
is the short list of what to pick up next**, ordered by what it is worth against what it takes.
Nothing here is a new idea nobody has considered; most of it is in `todo.md` §5 already. What
is new is that the release just shipped changed the arithmetic on several of them — three are
now much cheaper than they were, one has stopped being optional, and one unblocks four others
at once. Those changes are the reason this file exists rather than a pointer to §5.

There is one thing to do before any of it. It is not a feature.

---

## 0. Run the integration tests, on a machine with MySQL

**Before anything else, and it is not a judgement call.**

Twenty-five integration tests skipped in this release, because there is no MySQL on the
machine it was built on. Nine of them were written for the work that just shipped and cover
the step tables, the wording columns and the sub-module move.

```bash
mtms-backend/scripts/mysql-dev.sh up
cd mtms-backend && ./mvn.sh test
```

Until that runs, `JdbcStepRepository` is in exactly the position the entire JDBC layer was in
before 11 Sept: written, type-checked, reviewed, and never executed once. That is not a
hypothetical worry — it is where the last three real bugs were found, and all three would have
stopped the application on its first request:

- InnoDB refusing `ON DELETE CASCADE` on a column a stored generated column is built from.
- Connector/J answering a `java.util.UUID` parameter by writing Java serialisation bytes into
  the column, silently.
- `LAST_INSERT_ID()` being per-connection, so every project shared cache key 0.

None of those is findable against the in-memory store, because the in-memory store has no
InnoDB, no driver and no connections. The step repository has had none of that scrutiny yet.

**Also not done: nobody has clicked any of the new screens.** The API cannot be signed into on
a fresh database — the seeder was removed on 16 Sept and nothing replaces it — so the checklist
panel, the wording editor and the invitation list are type-checked and built, not used. Half an
hour in a browser against a real database is worth more than any amount of re-reading.

---

## 1. Measure where the time actually goes · medium · **the one that makes this different**

Say, per module and per step: *"CIQ sat waiting eleven days on average. Testing took two.
Prod loading took four hours."*

**Why this and not something else.** Every tool that claims to answer this asks people to
maintain estimates, and people do not maintain estimates, so the answer is wrong and everyone
learns to ignore it. This application already has the data as a by-product of being used:
`step_events` is append-only with a timestamp on every row, `audit_entries` has one on every
cell change, and both are written whether or not anyone is thinking about reporting. So the
answer is real **without anyone filling in a single extra field**, and it gets more accurate
the more the tool is used rather than less.

That is the property worth building on. It is also the argument that sells the tool to a
second team.

**What it takes.** Mostly a read. The events are stored; what is missing is the query that
pairs "entered this state" with "left it", and a screen. No new writes, no schema change.

Two things to get right, because they are the difference between a number and a true number:

- **A step that was ticked, un-ticked and ticked again** has two durations, not one. The
  events say so; a naive first-to-last would report the whole calendar span and be wildly
  wrong exactly on the work that went badly — which is the work anybody is asking about.
- **Median, not mean.** One activity that sat for four months will drag an average until it
  describes nothing. Show both if you like, but lead with the median.

---

## 2. Notifications · medium · **no longer optional**

Email first, then Teams or Slack.

**This changed status in the last release.** It used to be a nice extra. Now a checklist can
be marked `enforce_order`, which means the person who owns step 2 is *blocked* until step 1 is
ticked — and has no way whatsoever to learn that it was. A strict order without notifications
is a queue nobody can see the front of, and the predictable outcome is that people stop using
the ordered lists and go back to asking in a chat.

**What is already there.** `Mailer` is a port with one method, and `LoggingMailer` is the only
implementation — it writes the invitation link into a log and returns. So the seam exists and
the first real implementation is one class plus configuration, not a redesign.

**What to send, in the order they earn their place:**

1. A step you can tick became tickable — the predecessor is done.
2. A step you own was blocked, with the reason.
3. An @mention in a comment. (A comment nobody is told about is a comment nobody reads.)

**Worth deciding early:** digest or immediate. Immediate is simpler and is how people
discover, on day three, that the tool is noisy — at which point they mute it and you have lost
the channel permanently. A daily digest with immediate only for blocks is the safer default.

---

## 3. Put module ids on the wire · small · **unblocks four other things**

Today a module reaches the API as a *name* in the project's configuration — `ProjectConfig`
carries `List<String> moduleNames` — and has no id on the wire, even though `modules` has been
a real table with real ids since 11 Sept.

That single gap is currently blocking four separate items:

| Blocked | Why |
|---|---|
| **Module-level checklists** | Built and working in the domain, the schema and both repositories. The API refuses `scope_type: "module"` with that reason, because there is nothing for a caller to name |
| **Owners on a module** (§4 below) | Same — an owner row needs a scope id |
| **Discussions on a module** | Same |
| **The rebuilt module screen** (`todo.md` §4) | There is no id to open it by |

**What it takes.** Change the configuration shape from a list of strings to a list of
`{id, name}`, and follow it through: the config view, the Configure screen's module list, and
the matrix grouping. It is a mechanical change over a handful of files, and it is the cheapest
thing on this list per item unblocked.

Do this before 4 or 5, not after. Both of them want it.

---

## 4. Bulk-apply a checklist · small · **the thing between this and a real team**

One action: *apply this checklist to every sub-module on this module*. Plus a default
checklist for newly created sub-modules.

**Why it is not optional in practice.** CR_AUTOMATION has eighteen sub-modules today and the
real number is in the hundreds. Nobody is going to attach a checklist to two hundred things
one at a time, so without this the feature that just shipped gets used on a handful of rows as
a demonstration and then abandoned. This was already flagged as open in `todo.md` §3; shipping
steps is what turns it from a note into the blocker.

**One decision inside it:** does applying to all *replace* a sub-module's existing checklist or
sit alongside it? Alongside, almost certainly — the whole design allows several lists on one
thing, and a bulk action that silently replaces somebody's bespoke list is the kind of thing
that gets a tool banned. Make the replace case a separate, clearly worded action if it is
wanted at all.

---

## 5. Stop deleting cells when a column is deleted · small · **a principle currently broken**

The application is careful never to destroy a record. Hidden environments keep their ticks.
Narrowing a column's allowed statuses keeps the cells that are now off-vocabulary, and the
Configure screen counts them and says so. Retiring a step keeps its history and its comments.
Archiving is everywhere.

**Except one place.** `deleteColumn` deletes every cell in that column, in both
`JdbcProjectRepository` and `InMemoryProjectRepository`. The comment on it is honest about why
— orphan cells would reappear if somebody recreated a column with the same key — but that is
an argument for archiving the column, not for destroying months of recorded status.

**What it takes.** An `archived_at` on `deliverable_columns`, the projection filtering on it,
and the Configure screen offering "remove" as an archive. The re-creation case then resolves
itself: a column with the same key finds the archived one and offers to bring it back with
what it held.

Small, and it makes the promise the rest of the app already keeps true everywhere.

---

## 6. Decide what happens to the offline demo · **a decision, not a task**

`mtms-static` is what gets shown to clients, and every action has to be written twice — once
for the real server, once for the demo.

**The release just shipped roughly doubled the number of actions**: the step library, the
checklists, ticking, blocking, comments, the wording editor, the invitation list. None of it
was written into `mtms-static`, which is why that folder is now a release behind. It still
works correctly on its own — it is self-contained — it simply shows an older product in older
words.

Three ways forward, and the cost is different by an order of magnitude:

1. **Keep the demo doing everything.** Honest, and it means writing every future feature twice
   for as long as the demo exists.
2. **Make the demo look-only**, backed by the real API against a seeded read-only project.
   Cheapest to maintain, and it loses the thing that makes the demo good — a client can click.
3. **Retire it**, and demo the real application against a throwaway organisation. Possible now
   in a way it was not before: the super admin console can create an organisation, a project
   and an admin in about a minute.

Related and already decided in principle: **`mtms/` is redundant** — the same as `mtms-static`
apart from the demo layer — and deleting it removes a third of the copying work on every future
change. Nothing was done about it in this release, deliberately: renaming or updating a folder
already marked for deletion is wasted work, and deleting it is a decision rather than a task.

---

## Still outstanding from `todo.md`

Not repeated here in detail — `todo.md` §4 has the full reasoning for each. Listed so this file
is a complete picture of what is left rather than a partial one.

| | Size | Note |
|---|---|---|
| **Owners** — one overall, plus one per team, at every level | medium | Settled 15 Sept. Wants item 3 first for module-level owners. The `owners` table already exists |
| **Roles per project** — an admin adds or hides a role | medium | Build with owners; they read the same switch. Note that steps now gate on role ids, so hiding a role has to leave its ticks standing |
| **Discussions** on modules and sub-modules, with @mentions and attachments | medium | `threads`, `thread_comments` and `mentions` all exist and are unused. Wants item 3 for module scope, and item 2 for the mentions to mean anything |
| **Parent and child columns on Configure** | small | `FILECR` with `LAB`/`PRE`/`PROD` under it exists only because the seed data creates it that way; the screen cannot make one |
| **Rebuild the module screen** | medium | Blocked on item 3 |
| **Project templates** | medium | `todo.md` §5.3, and steps made it more valuable: a template now carries the checklists too, which is most of a team's set-up |
| **Import from a spreadsheet** | medium | Every team adopting this is holding one |
| **Releases**, **dependencies between sub-modules**, **blockers separate from defects**, **generated status reports**, **original vs current date**, **API tokens and a write API**, **saved views** | — | `todo.md` §5, unchanged in priority |

---

## One question still worth an answer

From `todo.md` §6, and it is still open because nobody has said otherwise:

**Does a project keep working if an admin deletes a role that steps are gated to?**

The code shipped on 16 Sept answers it the way the rest of the app answers everything of this
shape: the record stands, the configuration change does not erase it. The step keeps its ticks
and its history, and reads as *needing a role that no longer exists* until an admin picks a new
one. A step naming no role can be ticked by nobody — **not** by everybody, which is the
dangerous reading and is explicitly tested against.

Say if you would rather block the role from being deleted at all. That is a defensible
alternative; it is just a different one, and changing it later is a change to behaviour people
will have come to rely on.
