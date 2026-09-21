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

## 0. Sign in and use it · **done 19 Sept — eighteen bugs in two days**

**The integration tests have run** — `scripts/mysql-dev.sh up` works on this machine after all.
47 of them, against MySQL 8.0.40, and they found exactly the class of bug they were written for:
a `LIMIT` built by string concatenation came out as `LIMIT1000`, and every read of a project's
steps would have failed. Fourth bug of that kind; all four invisible to review. See `todo.md`
§2c.

**Somebody has now used it**, on the real deployment, and half an hour in a browser found five
bugs that three releases of review and a green test suite did not:

- An administrator of a **newly created** project could not sign in at all — the landing project
  was chosen without reference to whether that person was a member of it.
- The project switcher listed every project in the organisation, including ones the reader
  could not open.
- Switching project returned *"Expected a valid JSON body"* — the route took a query parameter
  and the client had always sent a body.
- Removing a value from a configuration list silently **added it back** and reported success.
- Inviting somebody from inside the app appeared to do nothing, and the links it did produce
  carried the domain twice.

All five are fixed and deployed. None of them were findable by reading the code, and four were
in the seam between two implementations that were assumed to match. That is the argument for
this section, made better than it was made in the abstract.

**Then ten more on 19 Sept**, from auditing what the frontend sends against what the service
reads rather than from clicking. Every operation on the checklist, owners, discussion and wording
panels was broken — all ten the same mistake, a camelCase key on a snake_case wire, so the field
arrived null. See `todo.md`, "Bug class: ten operations that never worked".

Four of those fifteen produced no error at all. The worst answered **200, said "saved", and
changed nothing** — because every field on that request is legitimately optional, so there was
nothing for the service to reject.

`lib/shared/__tests__/wire-contract.test.ts` now fails the build on a camelCase request key. It
found four of the ten on its first run, and two more once the shorthand `{ roleIds }` spelling
was handled.

**Then three more**, by sending all fifty-nine operations at a running service and re-reading the
state after each: a permission toggle that wiped every other permission on the role, a bad enum
that answered 500 instead of 422, and a write that un-hid a hidden role in one store but not the
other.

**Then three more again on 21 Sept**, and the lesson this time is different. All three guards
were green. What found these was asking a question none of them asks — *did the write change the
right amount of the world?* A reset email that used the invitation's wording; a `PATCH /me` that
answered 200, wrote the row correctly, and then poisoned the cache with a projection built from
the pre-write actor, so `me.display_name` stayed wrong for every later request; and
`LoggingMailer`, the documented fallback for a deployment with no relay, which had never run
anywhere because its condition tested whether a property existed rather than what it held.

`scripts/e2e-access.js` is the fourth guard. Every check re-reads the state and asserts on what
did **not** change as well as what did — which is the only shape that can tell *removed from a
project* from *removed from the organisation*. 42 checks.

**And one that is live right now and is not a code problem.** Ticking a permission on
mtms.azalio.io still wipes the role, because the deployed JAR is `bcdd4e2` and the fix from
19 Sept has never been shipped. A fix in the working tree is not a fix.

**Every screen and every operation has now been exercised.** What guards it from here is in
`todo.md` under "What guards this now" — a build-time rule and three scripts, all exiting
non-zero. Last run: 0 of 59 failed, 0 of 42 failed, 0 missing fields.

```bash
# the throwaway server, if it is not already up
mtms-backend/scripts/mysql-dev.sh up

# a way in
mysql -u mtms -p mtms < deploy/bootstrap.sql
```

Then half an hour in a browser. It is worth more than any further review, and it is the only
remaining way to find what is left.

---

## 1. Measure where the time actually goes · **built 18 Sept, made accurate 19 Sept**

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

**What was built.** `io.mtms.domain.Timing` — pure, like `StepGate` and `PromotionGate` — and a
*Where the time goes* panel on the dashboard. Per column: median days from a sub-module being
created to that column being done, the mean beside it, how much the column adds on the one
before it, and the count it was computed from. No new writes, no schema change.

**Median leads, the mean sits beside it**, exactly as this section asked: one activity that sat
for four months drags an average until it describes nothing, and when the two disagree sharply
the spread is itself the finding.

**Three limitations, stated on the screen rather than buried.** They are the difference between
a number and a true number:

- ~~**A cell keeps only its last change.**~~ **Fixed 19 Sept.** The column panel still reads
  cells and still has this limitation; a second panel — *Slowest steps* — reads the append-only
  `step_events` instead, so a step ticked, un-ticked and re-ticked reports **two durations rather
  than one long span**. That is what lets it say "CIQ received: 11 days, 2 done, 1 waiting" per
  step rather than only per column.

  One thing found while building it, worth recording: the step events already on the projection
  are **capped at the most recent thousand, newest first**. Measuring from that would have given
  confident numbers describing only the last fortnight, with nothing on the screen to say so. The
  timing query is a separate, uncapped read filtered to ticks and un-ticks — so what bounds it is
  the filter, not a LIMIT, and it grows with work completed rather than with activity.
- **Creation is not the same as starting.** A sub-module added in January and genuinely begun in
  March reads as five months. Honest about the tracker, misleading about the team — and the
  reason the median is reported next to the mean.
- **Unfinished work is excluded, never counted as instant.** A column where everything is stuck
  reports nothing rather than zero, and every row carries "from 2 of 60" so a confident number
  computed from almost nothing cannot be quoted without its denominator.

Twelve tests across the two panels, written from the angle of what somebody would wrongly
believe: that a mean of 2/4/300 days describes the work, that a column nobody has finished takes
no time, that a sub-activity's cells belong to its sub-module, that "done" means the same word in
every project, or that a step ticked twice took one long wait.

---

## 2. Email · **built 18 Sept** — needs a host in `mtms.env` to switch on

Notifications were already working: an in-app inbox, three events, and an optional Teams or
Slack webhook. Email was the gap, and the reason it was blocked is worth recording so nobody
re-litigates it.

That reason stopped being true: the mail library was not in the offline Maven
repository and the build ran with `-o`, but the build moved to `~/.m2p` and online on 15 Sept,
and `spring-boot-starter-mail` resolves. Built on 18 Sept.

**What was built.** `SmtpMailer` — `@Primary`, and `@ConditionalOnProperty("mtms.mail.host")`,
so it exists only when a host is configured and `LoggingMailer` is the only candidate otherwise.
Same arrangement as `WebhookNotifier`, for the same reason. It sends invitations and password
resets, plain text on purpose: the message is one sentence and one URL, and a second copy of the
link in an HTML part is a phishing heuristic on an email whose whole job is asking somebody to
click a link and type a password.

`Mailer` now returns a `Delivery` rather than void, so the screens say what actually happened
instead of asserting "there is no mail transport yet" — which had been wrong since the moment
this shipped. Verified both ways against a throwaway SMTP server: a working relay reports *"Sent
to tester@azalio.io"*, and a dead one reports *"The mail server refused it (failed to connect),
so it was not sent — send them the link instead"* while still showing the link.

**To switch it on:** six lines in `mtms.env` on the server (see `deploy/api.env.example`), then
`pm2 start ecosystem.config.js --update-env` — a plain `pm2 restart` does not re-read the file.

**Updated 21 Sept, and it is no longer optional.** Three things changed. The reset now has its
own message instead of borrowing the invitation's, because sending *"You have been invited to X"*
to somebody who has been signing in for months is the exact sentence a careful reader ignores.
There is a third message, an after-the-fact notice that a password has changed, with no link in
it on purpose — its reader's correct action if it was not them is to find an administrator, not
to click something in an email that has just told them their account may be compromised. And the
condition that switches SMTP on was wrong: `@ConditionalOnProperty("mtms.mail.host")` asks
whether a property is *present*, and `application.yml` defines it as `${MTMS_MAIL_HOST:}`, so
with no relay configured it still existed holding `""` and the SMTP bean won every deployment.
`LoggingMailer` had never run anywhere, which meant the documented fallback — write the link to
the log — was not happening.

That mattered little while every link also appeared on a screen. It matters now: *Forgotten your
password?* on the sign-in screen produces a link with **nobody at a keyboard to relay it**. Without
a mail host that button is switched on and does nothing a user can see. If you configure one
thing on that server, configure this.

**Still to decide: notification cadence.** This covers invitations and resets, which are
one-off and obviously immediate. The three *notification* kinds are a different question.
Immediate is simpler, and it is how people discover on day three that a tool is noisy — at which
point they mute it and the channel is gone for good. A daily digest, with immediate only for a
block, is the safer default. They are already distinguished by `kind`, so this is a policy
decision rather than a schema one.

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
