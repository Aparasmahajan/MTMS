# Deploying MTMS

Two programs. The **API** is a Spring Boot JAR on port 6011. The **web app** is a Next.js
server on port 6010. They talk over HTTP, so they can sit on one machine or two.

Built and checked together on 16 Sept 2026. *What was verified* at the end is also honest
about what was not.

**If you have deployed this before:** §0 is the whole of what changed. **There are now two
migrations** — read the schema note below before deploying.

---

## 0. What changed in this release

| | |
|---|---|
| **Steps** — the reusable checklist | New feature, on tables the schema already had. Routes under `/api/v1/steps` |
| **Owners** — one overall plus one per team, at every level | New. `/api/v1/owners` |
| **Roles per project** — an admin adds or hides a role | New. `/api/v1/roles`. **Migration V2** |
| **Discussions** with @mentions | New. `/api/v1/discussions` |
| **Notifications** — an in-app inbox, and an optional webhook | New. `/api/v1/notifications`. **Migration V3** |
| **Per-project wording** | Reads the three `*_label` columns that were already there and unused |
| **Move a sub-module between modules** | `PATCH /api/v1/sub-modules/{id}` accepts `module_name` |
| **Parent/child columns**, **bulk-apply a checklist**, **the module screen** | `/api/v1/config/columns/grouped`, `/api/v1/steps/lists/{id}/apply`, `/modules/{id}` |
| **Per-module "in prod" counts**; **recent-changes panel removed**; **invitation links persist**, and can be reissued | |

**The schema changes, and Flyway handles it.** `V1__initial_schema.sql` is byte-for-byte what
it has always been — that was the point of writing it in its final shape on 11 Sept, and it is
why steps, owners and discussions needed no migration at all. Two things genuinely did:

- **`V2__hideable_roles.sql`** — one column, `roles.archived_at`, plus an index. Hiding a role
  needs somewhere to record that it is hidden.
- **`V3__notifications.sql`** — the `notifications` table.

Both are additive: a column that defaults to NULL, and a new table. Nothing is dropped, nothing
is rewritten, and no existing row is touched. Flyway sees V1 already applied and runs V2 and V3
on the first start. **38 tables** afterwards.

There is nothing to do by hand. If Flyway reports a checksum mismatch on V1, something edited
that file after your database ran it — this release did not, so find what did before repairing
anything.

**Verified against a real MySQL 8.0.40 on 17 Sept**, which is new: all three migrations applied
in order to a database that already held V1, and the full suite ran green against it. See *What
was verified* at the end, which is also specific about the bug that found.

**No new permission key.** Building the step library and the checklists is gated on
`project.config`, the same permission that owns columns and stages; owners on `module.edit`;
discussions and the inbox on `project.view`. Ticking a step is gated by the roles named on the
step itself, which is data an admin sets. Nothing to grant before any of this works.

**One optional new setting**, and everything works without it — see §3.

**No new permission key.** Building the step library and the checklists is gated on
`project.config`, the same permission that owns columns and stages. A new key would be held by
nobody until an administrator granted it to every role by hand, so the feature would have
shipped switched off. Ticking a step is gated by the roles named on the step itself, which is
data an admin sets, not a permission. Nothing to grant before this works.

---

## 1. What the server needs

| | Version | Note |
|---|---|---|
| Java | **21** | The JAR will not run on Java 8 or 17 |
| Node.js | **20 or newer** | Only to run the web app |
| MySQL | **8.0.16 or newer** | The schema uses `CHECK` constraints, which older MySQL silently ignores |

Nothing else. Redis and Kafka are **optional** — see step 3.

---

## 2. The database

The schema `mtms` already exists. The application creates its own **38 tables** inside it on
first start, so **do not run the SQL by hand**.

**Creating the schema is not enough — the application also needs a user.** Missing this is
the most common first failure, and it surfaces as `Access denied for user 'mtms'@'localhost'`
at the end of a long stack trace.

```sql
CREATE USER IF NOT EXISTS 'mtms'@'localhost' IDENTIFIED BY 'put-a-real-password-here';
ALTER USER 'mtms'@'localhost' IDENTIFIED BY 'put-a-real-password-here';
GRANT ALL PRIVILEGES ON mtms.* TO 'mtms'@'localhost';
FLUSH PRIVILEGES;
```

`ALTER` as well as `CREATE`, so the same script works whether or not the user already
exists. Use `'mtms'@'localhost'` when the database is on the same machine as the API and
`'mtms'@'%'` when it is not — MySQL treats the host as part of the identity, so a user
created for one will be refused from the other.

`ALL PRIVILEGES` on that one schema is needed because the app creates and alters its own
tables at startup. It cannot touch anything outside `mtms`.

Prove the credentials before starting the application, where the error is one line rather
than a stack trace:

```bash
mysql -u mtms -p -e "SHOW DATABASES;"
```

---

## 3. Run the API

```bash
export SPRING_PROFILES_ACTIVE=mysql

# Database. The quotes around the URL are not optional — it contains `&`, which is the
# shell's background-job operator. Unquoted, the line runs as three commands, the variable
# is never set, and the failure arrives much later as "Access denied", because the app
# falls back to its built-in defaults.
export DATABASE_URL="jdbc:mysql://YOUR-DB-HOST:3306/mtms?sessionVariables=time_zone='%2B00:00'&characterEncoding=utf8&rewriteBatchedStatements=true"
export DATABASE_USER=mtms
export DATABASE_PASSWORD='put-a-real-password-here'

# Signing key for logins. Must be 32+ characters. Generate once, keep it secret,
# and never change it without logging everyone out.
export MTMS_SECURITY_JWT_SECRET="$(openssl rand -base64 48)"

# Where the browser reaches the web app. Used for CORS and invitation links.
export MTMS_CORS_ALLOWED_ORIGINS="http://YOUR-SERVER:6010"
export MTMS_APP_BASE_URL="http://YOUR-SERVER:6010"

# Optional: a Teams or Slack incoming webhook for notifications.
#
# Leave it unset and nothing breaks — every notification is written to the recipient's in-app
# inbox before any transport is attempted, so unset simply means the inbox is the only channel.
# It posts to one fixed channel, which is why the inbox is the primary route and this is the
# broadcast: the inbox tells the person, this tells the room.
#
# Email is deliberately not offered. It was the obvious first choice and is not buildable on
# the machine this was built on — the mail library is not in its offline Maven repository —
# so it is one class and one dependency away rather than done. See `Notifier`.
# export MTMS_NOTIFICATIONS_WEBHOOK_URL="https://outlook.office.com/webhook/..."

# See "The four traps" below before changing these.
export MTMS_SECURITY_SECURE_COOKIES=false
export MTMS_CACHE_TYPE=memory
export MTMS_EVENTS_PUBLISHER=logging
export SPRING_AUTOCONFIGURE_EXCLUDE=org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration,org.springframework.boot.autoconfigure.kafka.KafkaAutoConfiguration

java -jar mtms-api-1.0.0-SNAPSHOT.jar
```

Check it started:

```bash
curl http://localhost:6011/actuator/health
```

Expect `{"status":"UP"}`.

### The four traps

These are the ones that cost an afternoon each if you meet them by surprise.

**1. `MTMS_SECURITY_SECURE_COOKIES` must be `false` on plain HTTP.**
The `mysql` profile sets it to `true`, which tells the browser to send the login cookie
only over HTTPS. On an `http://` address the browser accepts the login, silently throws the
cookie away, and the next page bounces you back to the sign-in screen with **no error
message anywhere**. Set it to `false` until you have HTTPS, then set it back to `true`.

**2. A fresh database has no way in, and nothing will create one.**
The seeder that used to create the Flow One demo organisation and its accounts was deleted
on 16 Sept, once the real database was populated and it had no further purpose. Nothing
replaces it: point this at an empty schema and Flyway will build thirty-eight tables with no
organisation, no roles and no users, the service will start cleanly, and **no password will
get you in** — there is no self sign-up, and every account is created by an invitation from
somebody who is already an administrator.

So: keep a backup of the database, because it is now the only thing holding the ability to
sign in. If a fresh environment is ever needed, the first organisation, its admin role and
its first user have to be inserted with SQL by hand, or the seeder restored from git
history (`git log -- mtms-backend/src/main/java/io/mtms/infrastructure/persistence/Seeder.java`).

**3. The `mysql` profile also switches on Redis and Kafka.**
If you do not have them, the settings above turn them back off. Without
`SPRING_AUTOCONFIGURE_EXCLUDE`, the health check reports `DOWN` because it cannot reach
Redis, even though the app works — which will fail any load balancer health probe.

**4. `MTMS_CORS_ALLOWED_ORIGINS` must be the address the browser types**, not the server's
internal name. If the two disagree, every API call fails in the browser with a CORS error
while `curl` from the server works perfectly.

---

## 4. Run the web app

**Build it with an empty API address.** This is the recommended setup and the one that was
tested:

```bash
cd mtms-frontend
npm ci
NEXT_PUBLIC_API_BASE_URL= npm run build
npm start        # serves on port 6010
```

An empty address makes every call from the browser relative — `/api/v1/...` on port 6010 —
and this server forwards them to the API itself. Four things follow, and they are the four
that usually break a first deployment:

| | |
|---|---|
| **No domain needed** | Nothing about the public address is compiled in. The same build works on `localhost`, on a bare IP, and on a domain later, with no rebuild |
| **No CORS** | Same origin, so `MTMS_CORS_ALLOWED_ORIGINS` never has to match what the user typed |
| **Login works on plain HTTP** | A cross-origin cookie needs `SameSite=None; Secure`, which means HTTPS. Same-origin needs none of it |
| **One open port** | Only 6010 is exposed. The API can be closed to the outside entirely |

**The forwarding target is fixed at build time, not run time.** Next.js evaluates
`rewrites()` during the build and writes the result into `routes-manifest.json`, so setting
`API_PROXY_TARGET` on `npm start` does nothing. It defaults to `http://localhost:6011`;
override it on the **build** if the API is somewhere else:

```bash
API_PROXY_TARGET=http://localhost:6011 NEXT_PUBLIC_API_BASE_URL= npm run build
```

Only that private hop is compiled in, never the public address — which is why one build
still works on localhost, on an IP, and on a domain later.

Since nothing outside needs to reach the API directly, bind it to loopback only:

```bash
SERVER_ADDRESS=127.0.0.1
```

### The alternative, if you would rather not proxy

Build with the address a user's browser can reach, and set `MTMS_CORS_ALLOWED_ORIGINS` to
match exactly. Both ports then have to be open, login needs HTTPS to keep its cookie, and
**changing the address means rebuilding the frontend**:

```bash
NEXT_PUBLIC_API_BASE_URL=http://YOUR-SERVER:6011 npm run build
```

---

## 4a. One script instead of nine commands

`scripts/release.sh` does all of the above in the right order. It replaces the loose commands
that used to live in `com.txt`; three of those were destructive and one was silently
order-dependent, which is a bad shape for something run by hand at the end of a day.

```bash
./scripts/release.sh build      # compile both, run the tests
./scripts/release.sh package    # build, then produce the jar and the frontend tarball
./scripts/release.sh deploy     # package, copy to $MTMS_HOST, restart there
./scripts/release.sh status     # is it up
```

On the server, from `~/mtms`:

```bash
./release.sh restart            # stop, unpack, start, verify — and say which log to read if not
```

Three things it does that the old commands did not:

- **It runs the tests.** `com.txt` passed `-DskipTests`, which is right when re-packaging
  something already tested and wrong as a default. `MTMS_SKIP_TESTS=1` gets the old behaviour.
- **It copies `public/`** into the standalone bundle. Next.js does not, and missing it serves
  HTML with no assets, which reads as a broken build rather than a missed copy.
- **It checks afterwards** and, when something is down, says which log holds the reason
  instead of printing two numbers.

`deploy` refuses unless `MTMS_HOST` is set. Everything else — ports, the remote directory, the
proxy target — is an environment variable with a sane default; `./scripts/release.sh` with no
argument lists them.

---

## 5. First login

> **Historical.** The seeder described here was removed on 16 Sept, after the production
> database had been populated. The accounts below exist in that database and are how you sign
> in; a *new* database will not get them, and nothing will create them — see trap 2 above.

The first start used to create the Flow One organisation and these accounts.

| Sign in as | Password | Role | Use it for |
|---|---|---|---|
| `paras.mahajan@azalio.io` | `paras2002` | Admin + **super admin** | The admin console at `/platform` — creating projects and assigning their admins |
| `anand@azalio.io` | `tracker` | Admin | Running a project day to day |
| `narayana@azalio.io` | `tracker` | DevOps | Confirming what is loaded in prod |
| `dhruv@azalio.io` | `tracker` | Viewer | Showing what read-only looks like |

The other seeded people — Sanjay, Ritu, Vinayak, Muskan, Bhavnish — also use `tracker`.
They exist to demonstrate what each role can and cannot do.

**Do these three things immediately:**

1. **Change the super admin password.** `paras2002` is in source control, which makes it a
   first-login credential rather than a secret. Anyone who can read the repository can read
   it.
2. Change or delete the other seeded accounts. They all share one password.

`MTMS_SEED_ON_EMPTY_DATABASE` no longer does anything and can be dropped from the
environment file; the seeder it controlled is gone.

---

## 6. Check it works

In order. Each step tells you which part is wrong if it fails.

```bash
# 1. API is alive
curl http://localhost:6011/actuator/health

# 2. Database is connected and holds the accounts — should return a token
curl -X POST http://localhost:6011/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"paras.mahajan@azalio.io","password":"paras2002"}'

# 3. Web app is serving
curl -I http://YOUR-SERVER:6010/login

# 4. The new routes exist and are behind the login. 401, never 404 —
#    404 here means the JAR is the old one.
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:6011/api/v1/steps/library
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH http://localhost:6011/api/v1/config/vocabulary
```

Then open `http://YOUR-SERVER:6010` in a browser and sign in. You should see **18
sub-modules across 6 modules** and a matrix of **26 columns**. If the page loads but the
matrix is empty, it is trap 1 or trap 4 above — open the browser's developer console, which
will say which.

### Checking this release specifically

Signed in as an admin:

1. **Configure → What this project calls things.** Type `Node` in the first box and click
   away. Every heading in the app changes word. Nothing underneath is renamed, so this is
   safe to try and undo.
2. **Configure → Step library.** Add a step, tick one or two roles under "who may tick it".
3. **Configure → Checklists.** Pick a sub-module, add a checklist, add the step to it.
4. **Open that sub-module.** The checklist is above the deliverables. Signed in as somebody
   who does *not* hold the step's role, the tick is disabled and says which role it needs.
5. **Block a step.** It asks for a reason and refuses an empty one — and the reason appears
   in the change feed, not only on the step.
6. **The landing page** shows `SBC — 12 of 19 in prod` per module, and no longer has a recent
   changes panel.

---

## 6a. When it will not start

Read the **last** `Caused by:` in the stack trace — that is the real fault. The rest is
Spring explaining which beans it could not build as a consequence.

| Message | What it means |
|---|---|
| `UnsupportedClassVersionError` | Java is not 21 |
| `Access denied for user 'mtms'@'localhost'` | The user does not exist, the password is wrong, or it was created for a different host. **Or** `DATABASE_URL` was left unquoted — see below |
| `Communications link failure` | MySQL is not listening where the URL says, or is refusing this host |
| `jwt-secret must be set and at least 32 characters` | The signing key is missing or short |
| `Validate failed: Migration checksum mismatch for migration version 1` | Something edited `V1__initial_schema.sql` after this database ran it. **This release did not** — if you see this, find what did before repairing anything |
| `Table 'mtms.flyway_schema_history' doesn't exist` after a partial run | A previous start failed halfway. Drop and recreate the schema; nothing is live yet |

### The unquoted URL trap

`DATABASE_URL` contains `&`, which is the shell's background-job operator. In an
environment file that gets **sourced**, an unquoted value runs as three separate commands
and the variable is never set at all. The application then falls back to its built-in
defaults and fails much later with `Access denied`, which points at the wrong thing.

The giveaway is a line like this when you source the file:

```
[2]+  Done                    characterEncoding=utf8
```

Wrap the value in double quotes and check it survived:

```bash
set -a && . ./mtms.env && set +a
echo "$DATABASE_URL"      # must end in rewriteBatchedStatements=true
```

---

## 6b. Putting it on a domain, with HTTPS

Nothing needs rebuilding. The public address was never compiled into the frontend — that is
what the proxy in step 4 buys. Three settings change, and one of them has an order that
matters.

```bash
MTMS_APP_BASE_URL=https://mtms.azalio.io
MTMS_CORS_ALLOWED_ORIGINS=https://mtms.azalio.io
MTMS_SECURITY_SECURE_COOKIES=true
```

**An origin is scheme, host and port — nothing else.** `https://mtms.azalio.io/api/v1/auth/login`
is a URL, not an origin, and as a value it would never match anything. No trailing slash
either.

**`MTMS_APP_BASE_URL` is the one that shows up in somebody's inbox.** It is the whole address
invitation links are built from, and the console sends it on unchanged — prefixing
`window.location.origin` to it is what produced links with the domain twice, fixed on 16 Sept.
Get it wrong and every invitation issued until you notice is a dead link, and since the server
keeps only a hash of each token, the repair is to reissue them (which the console can now do)
rather than to resend them.

**CORS is very likely irrelevant here.** With the proxy, the browser only ever calls the web
app's own origin and the forwarding happens server-side, so no preflight is made and the
`Origin` header is never checked. Set it anyway for anything that calls the API directly,
but do not expect changing it to fix a browser problem in this setup.

**Set `SECURE_COOKIES=true` only once HTTPS actually serves.** Too early and login fails
*silently* — the browser takes the response, drops the cookie and returns to the sign-in
page with nothing logged anywhere. Too late and the session cookie travels in the clear.

### The reverse proxy

```nginx
server {
    listen 443 ssl;
    server_name mtms.azalio.io;

    ssl_certificate     /etc/letsencrypt/live/mtms.azalio.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mtms.azalio.io/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:6010;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

It forwards to **6010 only**. The API stays on loopback (`SERVER_ADDRESS=127.0.0.1`) and is
never reachable from outside.

`X-Forwarded-Proto` is the one that gets forgotten. The API reads it — see
`forward-headers-strategy: framework` in `application.yml` — and without it Spring believes
every request arrived over plain HTTP and writes `http://` into links generated from behind
your HTTPS.

---

## 7. Keeping it running

### The server this actually deploys to

Verified on the box on **17 Sept 2026**, not copied from a template. If you are reading this
because something is down, start here — every value below has been the cause of a confusing
hour at least once.

| | |
|---|---|
| **Host** | `HRMSPRODUCTION`, Ubuntu with systemd |
| **Login** | `devteamjava` — **not** a dedicated service account, and not root |
| **Shared with** | at least one other app (`orbit`), behind the **same nginx**. This box is not yours alone; do not restart nginx casually |
| **Java** | 21.0.11 |
| **Node** | runs the Next.js 14.2.35 standalone bundle |
| **Database** | MySQL 8.0 at `jdbc:mysql://localhost:3306/mtms`, Flyway schema **v3** |
| **Process manager** | **pm2**, as `devteamjava`. Both apps. Was `nohup`, which is what caused the 502s |
| **Public address** | `https://mtms.azalio.io` |

Where things live — note that **none** of it is under `/opt`, which is what the generic
examples further down this file assume:

| Path | What |
|---|---|
| `~/mtms/backend/mtms-api-1.0.0-SNAPSHOT.jar` | the API |
| `~/mtms/backend/mtms.env` | its environment. Called `mtms.env`, **not** `api.env` |
| `~/mtms/frontend/mtms-frontend.tar.gz` | the web bundle as shipped |
| `~/mtms/frontend/dist-frontend/server.js` | the web bundle unpacked — what actually runs |
| `~/mtms/ecosystem.config.js` | the pm2 definition of both apps |
| `~/.pm2/logs/` | the logs. These append and survive restarts |

Ports, and which of them is reachable:

| Port | Process | Exposure |
|---|---|---|
| 6011 | API (Spring Boot / Tomcat) | **loopback only** — `127.0.0.1`. Never reachable from outside |
| 6010 | web app (Next.js) | bound `0.0.0.0`, and the **only** thing nginx proxies to |
| 443 | nginx | the public address |

The consequence of that table is the single most useful fact for diagnosing an outage:
**nginx forwards to 6010 and nothing else, so a `502 Bad Gateway` means the Next.js process is
gone.** Not the API, not the database, not nginx. Check `pm2 list` first, always.

Two things about this server that are *not* what the rest of this file describes, and cost an
afternoon each when you assume otherwise:

- **nginx does not log where `deploy/nginx/mtms.conf` says it does.** That file specifies
  `mtms.access.log` and `mtms.error.log`; neither exists on the box. The deployed vhost is a
  different file and logs to the shared default `/var/log/nginx/error.log`, mixed in with the
  other app's traffic. Find the real one with
  `sudo grep -rn mtms /etc/nginx/sites-enabled/`.
- **`devteamjava` is not in `adm` or `systemd-journal`.** So `journalctl` shows you your own
  units and nothing else, and every nginx log needs `sudo`. A `journalctl` command that
  returns nothing here has usually returned nothing *because of this*, not because there was
  nothing to report.

### Why pm2, and never `nohup`

**Do not run either program with `nohup ... &`.** It is the single thing most likely to take
this application down, and the way it fails is why it went unnoticed for weeks: nginx answers
`502 Bad Gateway`, the log ends mid-sentence with nothing wrong in it, and it happens a day or
two *after* a release rather than during one — so it never looks connected to anything you did.

`nohup` is not a process manager. It makes the process ignore `SIGHUP` and then walks away.
Nothing watches it, so it does not survive:

- **a crash**, or anything that sends it a signal — including a stray
  `pkill -f "node.*server.js"`, which is a line in both `com.txt` and `release.sh`
- **a reboot**. Nothing starts it again
- **the OOM killer**, which picks the largest process on the box — usually the JVM
- **`systemd-logind` reaping the user slice** at logout, if `KillUserProcesses=yes`. It is
  `no` on this box, so this one is *not* the cause here — but the default is
  distribution-dependent, so check with `grep -i killuserprocesses /etc/systemd/logind.conf`
  before assuming the same on another machine

### Putting it under pm2

On the server, once:

```bash
bash ~/mtms/install-pm2.sh
```

It checks the paths, hands the ports over from whatever `nohup` left running, starts both apps
from `ecosystem.config.js`, and tells you whether pm2 is set to come back after a reboot.
After this, `release.sh restart` drives pm2 instead of `nohup`.

**The reboot step is two commands and both are required:**

```bash
pm2 startup      # prints a sudo command — run it. It installs a systemd unit for pm2 itself
pm2 save         # writes the process list that unit replays on boot
```

Skip either and pm2 comes back **empty** after a reboot, which looks identical to the problem
you were fixing. `systemctl list-unit-files | grep pm2` tells you whether the first one took.

Day to day:

```bash
pm2 list                            # up? and how many times has it restarted?
pm2 logs mtms-web                   # these append and survive restarts, unlike web.log did
pm2 logs mtms-api --lines 50 --nostream
pm2 restart mtms-api
pm2 monit                           # live CPU and memory — how you catch an OOM loop
```

**A climbing restart count in `pm2 list` is not pm2 working.** It means something is still
killing the process and pm2 is now hiding it from you. Read the logs when you see it.

Two details in `ecosystem.config.js` worth knowing before you edit it:

- **It parses `mtms.env` as `KEY=value` and nothing else.** `set -a && . ./mtms.env` was a
  shell and tolerated more — a value containing `$OTHER` was expanded there and stays literal
  text here. That is the safe direction to be wrong in, but it is a difference.
- **The API has no `max_memory_restart`, on purpose.** pm2 measures RSS, and a healthy JVM's
  RSS is far larger than its heap, so a threshold that looks generous restarts a perfectly
  well application every few hours. Cap the heap instead — `JAVA_OPTS="-Xmx512m"` in
  `mtms.env`, which the config picks up.

### Where the logs are

Under pm2, and these are the ones to read:

| Path | What |
|---|---|
| `~/.pm2/logs/mtms-web-out.log` | the web app's stdout — the Next.js banner, request errors |
| `~/.pm2/logs/mtms-web-error.log` | the web app's stderr |
| `~/.pm2/logs/mtms-api-out.log` | the API's stdout — Spring, Flyway, Hikari |
| `~/.pm2/logs/mtms-api-error.log` | the API's stderr |
| `~/.pm2/pm2.log` | pm2's own daemon log — **why** it restarted something |
| `~/.pm2/dump.pm2` | the saved process list that `pm2 startup` replays on boot |

Reach them by name rather than by path, which also merges the two streams in order:

```bash
pm2 logs mtms-web                          # live
pm2 logs mtms-api --lines 200 --nostream   # the last 200, then exit
pm2 logs --err                             # only stderr, both apps
pm2 flush                                  # empty them all
```

Every line is timestamped — `time: true` in `ecosystem.config.js`. That is not cosmetic: the
first outage could not be dated at all, because the old logs had no timestamps and were
truncated by the restart that was meant to fix it.

**Two paths that will mislead you.** These are the `nohup` logs, and they are now frozen at
whatever was in them the last time the old commands ran. They are not being written any more,
so a stale error in either is not a current error:

```
~/mtms/backend/api.log        <- dead. Was `> api.log`, truncated on every restart
~/mtms/frontend/web.log       <- dead. Same
```

Delete them once you trust pm2, so nobody reads a fossil during an incident.

**nginx is elsewhere, shared, and needs `sudo`** — `devteamjava` is not in `adm`:

```bash
sudo tail -f /var/log/nginx/error.log      # 502s and upstream failures live here
sudo tail -f /var/log/nginx/access.log     # mixed with the other app on this box
```

Note these are the *default* log files, not the `mtms.access.log` / `mtms.error.log` that
`deploy/nginx/mtms.conf` specifies. That config is not the one deployed.

**pm2's logs grow without limit.** Unlike the truncating `nohup` ones, nothing rotates them —
which is the right trade for an incident and the wrong one for a year. Install the rotator once:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
```

### The Server Action probes

`mtms-web-out.log` fills with these, in bursts:

```
Error: Failed to find Server Action "x". This request might be from an older or newer deployment.
Error: Failed to find Server Action "0". ...
Error: Failed to find Server Action "action". ...
```

**This is not your traffic and not a bug in the app.** Two facts settle it:

- A real Server Action ID is a 40-character hex hash. `x`, `0`, `1` and `action` are none of
  them — they are the values a scanner tries.
- **This application defines no Server Actions at all.** There is not one `'use server'` in the
  frontend. So no legitimate request can ever carry a `Next-Action` header, and every one of
  these is somebody probing.

They arrive as POSTs with a `Next-Action:` header. Find out who:

```bash
sudo grep -c 'Next-Action' /var/log/nginx/access.log
sudo awk '$9 ~ /^(4|5)/ {print $1}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head
```

Because the app has no Server Actions, refusing the header outright cannot break anything.
In the `location / {}` block of the deployed vhost:

```nginx
# This app defines no Server Actions, so a request carrying this header is a probe by
# definition. 444 closes the connection without a response — cheaper than 403, and it
# does not write a response line for a scanner to measure.
if ($http_next_action) { return 444; }
```

Whether these probes are also what *killed* the process is not yet established — the app
logged them and kept serving. Watch the restart counter in `pm2 list`: if it climbs in step
with a burst in `mtms-web-out.log`, they are the cause, and the nginx rule above fixes the
outage as well as the noise.

### If you would rather use systemd

`deploy/systemd/` holds units for the same two processes. They assume a `/opt/mtms` install
owned by a dedicated `mtms` account, so on this server's home-directory layout they need their
paths changed and `ProtectHome=true` removed — with it, the service cannot see its own JAR.

The API shuts down gracefully: it finishes the requests it is already handling before
exiting, so a restart during working hours does not fail somebody's click.

### One thing to back up

The database, and nothing else. Both programs are stateless — the JAR and the frontend bundle
are rebuilt from git in two minutes. What cannot be rebuilt is the ability to sign in: since
the seeder was removed there is no path that creates a first account, so a lost database is a
locked door. See trap 2.

The one exception is per-browser: the invitation links the console keeps under "Invitation
links issued here" live in that browser's `localStorage` and are on nobody's backup. They do
not need to be — an unaccepted invitation can be reissued from the same screen — but do not
treat that list as a record of anything.

---

## What was verified, and what was not

**Verified on 17 Sept 2026, against a real MySQL 8.0.40** — the first time this has been true
since 11 Sept:

- **All 155 tests pass**, including **47 integration tests that had never executed before**.
  They cover the step tables, the owners table, the discussions tables, the notifications table,
  the per-project wording columns and the sub-module move.
- **All three migrations applied in order** to a database that already held V1. V1 untouched, V2
  and V3 additive, 38 tables afterwards.
- The JAR builds, the frontend type-checks, 31 frontend tests pass, and `next build` produces
  all 16 routes.
- `scripts/release.sh package` ran end to end and produced both artefacts.
- **The service was started from the built JAR** and answered `{"status":"UP"}`. Every new route
  answers **401 rather than 404**, so the whole Spring context wires and the routes are
  registered and behind the login.

### The bug that run found

One, and it would have taken the steps feature down completely.

```java
             ORDER BY ev.at DESC
             LIMIT """
                + EVENT_LIMIT,
```

A Java text block strips the trailing whitespace off every line, so this concatenated to
`LIMIT1000`. The query is in `JdbcStepRepository.load`, which **every project read calls** — so
every page of every project would have answered 500 the moment the service met MySQL. It
compiled, it type-checked, and it was reviewed twice.

It is a bind parameter now, which cannot lose a space.

That is the fourth bug of exactly this kind, after the foreign key InnoDB refuses, the driver
that writes Java serialisation bytes for a `java.util.UUID`, and `LAST_INSERT_ID()` being
per-connection. All four were invisible to review and to the in-memory store. The lesson is not
"write better SQL": **a repository nobody has executed is not finished**, whatever the review
said.

**Still not verified:**

- **Nobody has used the application.** A fresh database has no accounts — see trap 2 — so every
  screen built in the last three releases is type-checked, built, and has never been clicked.
  Run `deploy/bootstrap.sql`, sign in, and spend half an hour in it before trusting any of it.
- **`deploy/bootstrap.sql` itself** has been column-checked against the schema and never
  executed.
- **The webhook.** `MTMS_NOTIFICATIONS_WEBHOOK_URL` is unset here, so `LoggingNotifier` is what
  ran. The in-app inbox is verified; the posting is not.
- **Redis and Kafka.** The settings in step 3 switch them off.
- **HTTPS.** Everything above ran over plain HTTP. When you add TLS, set
  `MTMS_SECURITY_SECURE_COOKIES=true` — and note trap 1 in reverse: with HTTPS in place, leaving
  it `false` is a real weakness, not just untidy.
- **Your actual server.** The MySQL used here was a local throwaway on port 13306. Host,
  credentials and firewall are the remaining unknowns.

### From the previous release, still worth knowing

Three bugs were found and fixed on 14 Sept while verifying against a real MySQL: seeding
inserted memberships pointing at a project that did not exist yet and MySQL rejected the
foreign key; the super admin console crashed because the Java API never sent the list of
administrators per project; and an empty API address broke server-side rendering, because
Node has no current page for a relative path to be relative to. All three were invisible
against the in-memory store. That is the reason the "not verified" list above leads with
MySQL.
