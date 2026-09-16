# Deploying MTMS

Two programs. The **API** is a Spring Boot JAR on port 6011. The **web app** is a Next.js
server on port 6010. They talk over HTTP, so they can sit on one machine or two.

Built and checked together on 16 Sept 2026. *What was verified* at the end is also honest
about what was not.

**If you have deployed this before:** §0 is the whole of what changed. There is no migration
— deploy the new JAR and the new frontend.

---

## 0. What changed in this release

| | |
|---|---|
| **Steps** — the reusable checklist | New feature, on tables the schema already had. New routes under `/api/v1/steps` |
| **Per-project wording** | Reads the three `*_label` columns on `projects` that were already there and unused |
| **Move a sub-module between modules** | `PATCH /api/v1/sub-modules/{id}` now accepts `module_name` |
| **Per-module "in prod" counts** on the landing page | Frontend only, counted from data already in the snapshot |
| **The "recent changes" panel** on the landing page | Removed, as asked on 15 Sept |
| **Invitation links stop disappearing** | The console keeps issued links until cleared, and can reissue one |

**The schema does not change, and there is no migration.** This is the pleasant consequence
of a decision made on 11 Sept: `V1__initial_schema.sql` was written in its final shape, with
the nine `step_*` tables and the three `module_label` / `sub_module_label` /
`sub_activity_label` columns already in it, before any of them had code behind them. They have
been sitting in your database unused ever since.

So this release is the code that finally reads and writes them. `V1` is byte-for-byte what it
was, Flyway sees the checksum it expects, and an existing database needs nothing done to it —
deploy the new JAR and the new frontend and that is the whole of it. Still 36 tables.

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

The schema `mtms` already exists. The application creates its own **36 tables** inside it on
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
replaces it: point this at an empty schema and Flyway will build thirty-six tables with no
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

The JAR is an ordinary process. Run it under `systemd` or NSSM so it restarts on reboot:

```ini
[Unit]
Description=MTMS API
After=network.target mysql.service

[Service]
EnvironmentFile=/etc/mtms/api.env
ExecStart=/usr/bin/java -jar /opt/mtms/mtms-api-1.0.0-SNAPSHOT.jar
Restart=always
User=mtms

[Install]
WantedBy=multi-user.target
```

Put the environment variables from step 3 in `/etc/mtms/api.env`, one `KEY=value` per line
and no `export`. Do the same for the web app with `npm start`.

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

**Verified on 16 Sept 2026:**

- The JAR builds and **75 tests pass** — 46 that were there before, plus 14 covering the step
  gate (order, roles, blocking) and 15 driving the step use cases end to end against the
  in-memory store: who may tick, what an admin's override records, what a strict order refuses
  and names, that un-ticking is never held up by the order, that retiring a step keeps its
  history, and that taking a ticked step off a checklist is refused.
- The frontend type-checks with no errors, **31 unit tests pass** (22 existing, 9 new covering
  the per-project wording and its plurals), and `next build` produces all 15 routes.
- `scripts/release.sh package` was run end to end and produced both artefacts.
- **The service was started from the built JAR** and answered `{"status":"UP"}`. Every new
  route — `POST /api/v1/steps/library`, `PATCH /api/v1/steps/entries/{id}`,
  `POST /api/v1/steps/lists`, `PATCH /api/v1/config/vocabulary` and the invitation reissue —
  answers **401 rather than 404**, so the whole Spring context wires and the routes are
  registered and behind the login.

**Not verified, and you should assume nothing about it:**

- **Anything against a real MySQL.** There is no MySQL on this machine, so all **25**
  integration tests skipped — the 16 that existed and the 9 written for this release, which
  cover the step tables, the wording columns and the sub-module move. Run
  `mtms-backend/scripts/mysql-dev.sh up` and then `./mvn.sh test` to execute them. Until that
  is done, the JDBC step repository is in exactly the position the whole JDBC layer was in
  before 11 Sept: written, type-checked, reviewed, and never run. That is precisely where the
  last three real bugs were found.
- **The screens, in a browser.** The API cannot be signed into here — an empty in-memory
  database has no accounts and nothing creates one — so no screen was clicked. The checklist
  panel, the wording editor and the invitation list are type-checked and built, not used.
- **Redis and Kafka.** The settings in step 3 switch them off.
- **HTTPS.** Everything above ran over plain HTTP. When you add TLS, set
  `MTMS_SECURITY_SECURE_COOKIES=true` — and note trap 1 in reverse: with HTTPS in place,
  leaving it `false` is a real weakness, not just untidy.

### From the previous release, still worth knowing

Three bugs were found and fixed on 14 Sept while verifying against a real MySQL: seeding
inserted memberships pointing at a project that did not exist yet and MySQL rejected the
foreign key; the super admin console crashed because the Java API never sent the list of
administrators per project; and an empty API address broke server-side rendering, because
Node has no current page for a relative path to be relative to. All three were invisible
against the in-memory store. That is the reason the "not verified" list above leads with
MySQL.
