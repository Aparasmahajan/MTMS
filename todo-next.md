# MTMS — what to do next

Written 16 Sept 2026, straight after the release that added steps, per-project wording and the
small pile (see `todo.md` §2a for what that was).

**Updated 17 Sept**, twice. Section 4 of `todo.md` is finished — owners, roles per project,
discussions, the module screen, parent/child columns, bulk-apply and notifications. Items 2, 3,
4 and 5 of the original version of this list are done or resolved and have been removed, and so
has the old item 0: the integration tests have run.

`todo.md` is the long record — every decision, why it was made, and what it cost. This file is
the short list of what to pick up next.

There is one thing to do before any of it. It is not a feature, and it has now been outstanding
for two releases.

---

## 0. Sign in and use it

**The integration tests have run** — `scripts/mysql-dev.sh up` works on this machine after all.
47 of them, against MySQL 8.0.40, and they found exactly the class of bug they were written for:
a `LIMIT` built by string concatenation came out as `LIMIT1000`, and every read of a project's
steps would have failed. Fourth bug of that kind; all four invisible to review. See `todo.md`
§2c.

So the thing that has still never happened is **somebody using the application**. A fresh
database has no accounts — the seeder went on 16 Sept — so every screen built across three
releases is type-checked, built, and unclicked: the checklist panel, the wording editor, the
owners panel, the discussion panel, the roles panel, the module screen, the inbox.

```bash
# the throwaway server, if it is not already up
mtms-backend/scripts/mysql-dev.sh up

# a way in
mysql -u mtms -p mtms < deploy/bootstrap.sql
```

Then half an hour in a browser. It is worth more than any further review, and it is the only
remaining way to find what is left.

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

## 2. Email, when there is a network that allows it

Notifications are built and working: an in-app inbox, three events, and an optional Teams or
Slack webhook. What is not built is email, and the reason is narrow and worth recording so
nobody re-litigates it.

The mail library is not in this machine's offline Maven repository, and the build runs with
`-o` because the network refuses the registry. So `SmtpNotifier` is one class implementing an
interface that already exists, plus `spring-boot-starter-mail` in the pom, on any machine that
can fetch it.

**Decide the cadence at the same time.** Immediate is simpler, and it is how people discover on
day three that a tool is noisy — at which point they mute it and the channel is gone for good. A
daily digest, with immediate only for a block, is the safer default. The three events are
already distinguished by `kind`, so this is a policy decision rather than a schema one.

---

## 3. File attachments on discussions

CIQ documents, screenshots and logs are exactly what gets pasted into a chat today and lost
tomorrow. The discussion feature shipped without them, deliberately, because they need a
decision this repository cannot make on its own: **where do the bytes live?**

- **The database.** Simplest to back up — the database is already the one thing that must be
  backed up — and the one that makes the backup ten times larger.
- **A disk on the server.** Cheapest, and it makes the application stateful: a second instance
  cannot see the first one's files, and the backup story becomes two things instead of one.
- **An object store.** Right answer at size, another service to run and another credential to
  hold.

None is wrong. Pick one deliberately rather than discovering it, because moving afterwards means
moving data.

---

## 4. Custom fields on the module screen

Named in `todo.md` §4 as part of the rebuilt module screen, and the only part not built.

There is no table for them, and that is the point: inventing a generic
`(entity, key, value)` store before anybody has named a specific field is how you get a schema
nobody uses and a screen nobody fills in. Ask which two fields are actually wanted first — the
answer is often that they are columns, or a description, and both of those already exist.

---

## 5. Decide what happens to the offline demo · **a decision, not a task**

`mtms-static` is what gets shown to clients, and every action has to be written twice — once
for the real server, once for the demo.

**Two releases have now roughly tripled the number of actions**: the step library, the
checklists, ticking, blocking, comments, the wording editor, the invitation list, owners,
roles, discussions and the module screen. None of it was written into `mtms-static`, which is
why that folder is now two releases behind. It still
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

Section 4 is finished apart from the three items above. What is left is section 5 — the ideas,
not the backlog.

| | Note |
|---|---|
| **Releases** — group sub-modules into "the September drop" and track it as one thing | PMs think in releases, not in individual modules. A project is one long flat list today |
| **Project templates** | Worth more than it was: a template now carries the checklists, the roles and the wording too, which is most of a team's set-up |
| **Import from a spreadsheet** | Every team adopting this is holding one |
| **Dependencies between sub-modules** | "147 cannot go until 5 is done." No home in the app today |
| **Blockers, separate from defects** | A defect is a bug; a blocker is "waiting on a third party". Steps can now be blocked with a reason, which is half of it |
| **Status reports, generated** | The history to write the weekly update by hand is all stored |
| **Original date versus current date** | So slippage is visible rather than quietly rewritten |
| **API tokens and a write API** | A build that ticks "testing done" itself is worth more than any screen |
| **Saved views** | The matrix gets wide once each project configures its own columns |

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
