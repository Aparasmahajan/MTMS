# MTMS — commands

Everything that used to be in `com.txt`, plus what it was missing, arranged by **what you are
trying to do** rather than by which program it belongs to.

Two machines are involved and they are not the same. Commands are marked:

- **[local]** — your Windows machine, in Git Bash. `java` and `mvn` on PATH here are a JDK 8
  from 2022 and Maven 3.0.5 from 2013, and neither builds this. Use `./mvn.sh`.
- **[server]** — the Linux box it runs on.

Ports: **API 6011**, **web app 6010**. JAR: `mtms-api-1.0.0-SNAPSHOT.jar`.

---

## Right now — shipping the 17 Sept release

Both halves changed. **Two migrations run on the first start** (`V2__hideable_roles.sql`,
`V3__notifications.sql`); both are additive — one nullable column and one new table — and Flyway
applies them itself. Nothing to do by hand.

One **optional** new setting, `MTMS_NOTIFICATIONS_WEBHOOK_URL`. Leave it unset: notifications go
to an in-app inbox either way, and unset simply means that is the only channel.

The artefacts currently built in the repo:

| | Bytes | md5 |
|---|---|---|
| `mtms-api-1.0.0-SNAPSHOT.jar` | 79,824,563 | `45073e6f512aa910cc0fa948e3d646a0` |
| `mtms-frontend.tar.gz` | 4,605,284 | `84f86251f8b2585185ab81dfdcdbe6f4` |
| `.next/BUILD_ID` | | `rIfMheShkn90rlQSoQvAw` |

**One command** [local] — builds, tests, copies, checksums both ends, refuses on a mismatch,
restarts and verifies:

```bash
cd "$REPO" && MTMS_HOST=devteamjava@HRMSPRODUCTION ./scripts/release.sh deploy
```

**Or by hand.** Copy [local]:

```bash
cd "$REPO"
scp "mtms-backend/target/$JAR" "mtms-frontend/$WEB" devteamjava@HRMSPRODUCTION:~/mtms/
```

Check before stopping anything [server] — a transfer to this box has silently corrupted a JAR
once while the byte count matched:

```bash
md5sum ~/mtms/$JAR ~/mtms/$WEB
```

Only if both match the table above:

```bash
mv ~/mtms/$JAR $API_DIR/ && mv ~/mtms/$WEB $WEB_DIR/
pkill -u $USER -f "$JAR"; pkill -u $USER -f "node.*server.js"
sleep 2
cd $WEB_DIR && rm -rf dist-frontend && tar -xzf $WEB
cd $API_DIR && set -a && . ./mtms.env && set +a && nohup java -jar $JAR > api.log 2>&1 &
cd $WEB_DIR/dist-frontend && PORT=$WEB_PORT HOSTNAME=0.0.0.0 nohup node server.js > ../web.log 2>&1 &
```

**Watch the first start.** This is the one where the migrations run:

```bash
sleep 15
grep -E "Migrating schema|Successfully applied" $API_DIR/api.log
```

Expect V2 and V3. Then confirm it is genuinely the new build:

```bash
curl -s -o /dev/null -w 'api %{http_code}
' http://localhost:$API_PORT/actuator/health
curl -s -o /dev/null -w 'web %{http_code}
' http://localhost:$WEB_PORT/login
cat $WEB_DIR/dist-frontend/.next/BUILD_ID                      # rIfMheShkn90rlQSoQvAw
grep -rl "Step library" $WEB_DIR/dist-frontend/.next/server    # should print a page.js
curl -s -o /dev/null -w 'owners %{http_code}
' -X POST http://localhost:$API_PORT/api/v1/owners
```

The last line must be **401, not 404**. 404 means the old JAR is still running.

**In the browser:** Configure has *What this project calls things*, *Step library* and
*Checklists*; Access has *Roles in this organisation*; a sub-module has owners, a checklist and
a discussion; the header has an *Inbox*; and a module name on the landing page opens a screen of
its own.

> **This release was verified against a real MySQL 8.0.40** — the first one that has been. All
> 155 tests pass, including 47 integration tests that had never executed before today, and all
> three migrations applied in order. That run found one real bug: a `LIMIT` built by string
> concatenation came out as `LIMIT1000`, and **every read of a project's steps would have
> failed**. Still not done: nobody has clicked the screens, because a fresh database has no
> accounts — see §9.

---

## Contents

0. [Set these once](#0-set-these-once)
0a. [Verify what actually shipped](#0a-verify-what-actually-shipped)
1. [Is it running?](#1-is-it-running)
2. [Reading the logs](#2-reading-the-logs)
3. [Changing a setting in the environment file](#3-changing-a-setting-in-the-environment-file)
4. [Deploying new files and restarting](#4-deploying-new-files-and-restarting)
5. [Building](#5-building)
6. [Running it locally](#6-running-it-locally)
7. [Tests](#7-tests)
8. [Database](#8-database)
9. [First account on an empty database](#9-first-account-on-an-empty-database)
10. [When something is wrong](#10-when-something-is-wrong)

---

## 0. Set these once

Everything below is written against variables so it works on any environment, not just the one
it was first typed on. Paste this block at the top of a session and the rest can be
copy-pasted unchanged.

**[local]** — your Windows machine, Git Bash:

```bash
export MTMS_HOST=devteamjava@HRMSPRODUCTION   # user@server
export REPO="C:/Users/parmahaj/Documents/New folder/MTMS"
export JAR=mtms-api-1.0.0-SNAPSHOT.jar
export WEB=mtms-frontend.tar.gz
```

**[server]**:

```bash
export API_DIR=~/mtms/backend      # the JAR and its environment file
export WEB_DIR=~/mtms/frontend     # the tarball, and dist-frontend/ unpacked from it
export ENV_FILE=$API_DIR/mtms.env  # NOT api.env — this server calls it mtms.env
export JAR=mtms-api-1.0.0-SNAPSHOT.jar
export API_PORT=6011
export WEB_PORT=6010
```

> **The layout is split and the env file is not called what the examples call it.** The JAR
> lives in `~/mtms/backend` beside `mtms.env`; the web bundle lives in `~/mtms/frontend`. A
> command that assumes one flat directory, or an `api.env`, will fail on this server.
> `scripts/release.sh` defaults to exactly the layout above; override with `MTMS_API_DIR`,
> `MTMS_WEB_DIR` and `MTMS_ENV_FILE` anywhere else.

The public address is `https://mtms.azalio.io`, behind nginx, forwarding to the web app on
**6010**. The API on **6011** is not reachable from outside and should not be made so.

---

## 0a. Verify what actually shipped

**Do this before restarting anything, and after.** It is four commands and it has already
earned its place twice on this server.

### Before: did the file survive the copy?

A transfer to HRMSPRODUCTION once arrived as **`Invalid or corrupt jarfile` while the byte
count matched exactly**. Size proves nothing. The failure surfaces as a service that will not
start — ten minutes after you stopped the one that was working.

```bash
# [local] — the numbers to match
md5sum "$REPO/mtms-backend/target/$JAR" "$REPO/mtms-frontend/$WEB"

# [server] — compare, and only then restart
md5sum $API_DIR/$JAR $WEB_DIR/$WEB

# [server] — a JAR can also be verified on its own terms
unzip -t $API_DIR/$JAR | tail -1     # "No errors detected in compressed data"
```

If they differ, **re-copy. Do not restart.** `./scripts/release.sh deploy` does this check for
you and refuses to go on.

### After: is the running process the new one?

Restarting is not the same as having restarted. An old process nobody killed holds the port,
the new one exits on *Address already in use*, and everything looks up because something is
answering.

```bash
# [server] when did the running API actually start?
ps -eo pid,lstart,cmd | grep "$JAR" | grep -v grep
```

Compare that timestamp with when you ran the restart. Well before it means you are still
talking to the old JAR.

```bash
# [server] is anything else holding the ports?
ss -ltnp | grep -E "$API_PORT|$WEB_PORT"
```

### After: is the new frontend really being served?

**`curl` cannot answer this.** The console and the Configure screen are client-rendered — React
fills the text in after the page loads, so it is not in the HTML curl receives. Grep the built
bundle instead:

```bash
# [server] the build identity — changes on every build
cat $WEB_DIR/dist-frontend/.next/BUILD_ID

# [server] does the bundle contain something only THIS release has?
grep -rl "What this project calls things" $WEB_DIR/dist-frontend/.next/server 2>/dev/null
grep -rl "Invitation links issued here" $WEB_DIR/dist-frontend/.next/server 2>/dev/null
```

Each should print a `page.js` path. Nothing printed means the old bundle is still in place —
usually because `dist-frontend` was not removed before untarring, so the new files merged in
around the old ones.

### After: are the new API routes there?

401, never 404. A 404 means the old JAR is running.

```bash
# [server]
for p in /api/v1/steps/library /api/v1/config/vocabulary; do
  printf '%s -> %s\n' "$p" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:$API_PORT$p)"
done
```

---

## 1. Is it running?

**The one command.** [server]

```bash
cd ~/mtms && ./release.sh status
```

```
  api  200  http://localhost:6011/actuator/health
  web  200  http://localhost:6010/login
```

Anything other than `200` and it names the log to read. `000` means nothing is listening at
all — the process is not up, as opposed to up and unhealthy.

**By hand**, if the script is not there: [server]

```bash
curl -s -o /dev/null -w 'api %{http_code}\n' http://localhost:6011/actuator/health
curl -s -o /dev/null -w 'web %{http_code}\n' http://localhost:6010/login
```

**Are the processes actually alive?**

```bash
pgrep -af "mtms-api-1.0.0-SNAPSHOT.jar"
pgrep -af "node.*server.js"
```

> `com.txt` used `jobs -l` for this. That only lists jobs started by **the shell you are typing
> in** — reconnect over SSH and it prints nothing at all, whether or not the app is running.
> Use `pgrep`.

**Is anything holding the ports?**

```bash
ss -ltnp | grep -E '6010|6011'
```

Useful when a start "succeeds" and the health check still fails: usually an old process never
died and the new one exited on *Address already in use*, which is in the log and nowhere else.

**Under systemd**, if you installed the units from `deploy/systemd/`:

```bash
systemctl status mtms-api mtms-web
systemctl is-active mtms-api          # prints: active | failed | inactive
```

---

## 2. Reading the logs

**Started with `release.sh` / `nohup`** — plain files: [server]

```bash
tail -f $API_DIR/api.log               # the API, live
tail -f $WEB_DIR/web.log               # the web app, live
tail -200 $API_DIR/api.log             # the last 200 lines
```

**Under systemd:**

```bash
journalctl -u mtms-api -f              # live
journalctl -u mtms-api -n 200          # last 200 lines
journalctl -u mtms-api --since "10 min ago"
journalctl -u mtms-web -f
```

**Finding the actual fault in a startup failure.** A Spring stack trace is mostly Spring
explaining which beans it could not build *as a consequence*. The real fault is the **last**
`Caused by:`:

```bash
grep -n "Caused by:" $API_DIR/api.log | tail -3
```

**Following one user's click across both programs.** Every request carries a correlation id,
printed in `[brackets]` in each line:

```bash
grep "a1b2c3d4" $API_DIR/api.log
```

**Did it start cleanly at all?**

```bash
grep -E "Started MtmsApplication|Tomcat started on port" $API_DIR/api.log | tail -2
```

---

## 3. Changing a setting in the environment file

The environment file on HRMSPRODUCTION is **`~/mtms/backend/mtms.env`** — not `api.env`, and
not in `~/mtms`. Start from `deploy/api.env.example` if you are building a new one.

```bash
cd $API_DIR
cp mtms.env mtms.env.bak               # it holds the DB password and the session signing key
nano mtms.env
chmod 600 mtms.env                     # if you have just created it
```

**Then check the value survived being read — this is not optional for `DATABASE_URL`:**

```bash
set -a && . $ENV_FILE && set +a
echo "$DATABASE_URL"                   # must END IN rewriteBatchedStatements=true
```

> **Why that check exists.** `DATABASE_URL` contains `&`, which is bash's background-job
> operator. Sourced *unquoted*, the line runs as three separate commands, the variable is never
> set at all, and the application falls back to its built-in defaults — so the failure arrives
> much later as `Access denied for user 'mtms'@'localhost'`, pointing at the wrong thing
> entirely. The giveaway is a line like `[2]+  Done   characterEncoding=utf8` when you source
> it. Keep the quotes.

**A change takes effect only on restart.** Nothing here is re-read while running:

```bash
cd ~/mtms && ./release.sh restart
# or, under systemd:
sudo systemctl restart mtms-api
```

**Generating a signing key**, when you need one:

```bash
openssl rand -base64 48
```

`MTMS_SEED_ON_EMPTY_DATABASE` is inert — the seeder it controlled was deleted on 16 Sept.
Harmless to leave in the file, fine to remove.

### The settings you are most likely to be changing

| Setting | Change it when | Watch out for |
|---|---|---|
| `MTMS_SECURITY_SECURE_COOKIES` | `true` once HTTPS actually serves | Too early and **login fails silently** — the browser takes the response, drops the cookie, and returns you to the sign-in page with nothing logged anywhere |
| `MTMS_APP_BASE_URL` | Moving to a domain | It is the whole address invitation links are built from. Wrong, and every invitation issued until you notice is a dead link — reissue them from the console, resending will not help |
| `MTMS_CORS_ALLOWED_ORIGINS` | Moving to a domain | Scheme, host and port only. Not a path, no trailing slash. Largely irrelevant with the proxy setup, because the browser only ever calls the web app's own origin |
| `DATABASE_PASSWORD` | Rotating it | Change it in MySQL **and** here, then restart. The pool holds open connections, so the old password appears to keep working until then |
| `MTMS_SECURITY_JWT_SECRET` | Almost never | Changing it logs **everyone** out — every issued token stops verifying |

### Frontend settings are a different thing entirely

`NEXT_PUBLIC_API_BASE_URL` and `API_PROXY_TARGET` are **compiled in at build time**. Setting
them in an env file on the server does nothing whatsoever — Next.js evaluates `rewrites()`
during the build and writes the result into `routes-manifest.json`. To change either, rebuild:

```bash
# [local]
cd mtms-frontend
API_PROXY_TARGET=http://10.0.0.5:6011 NEXT_PUBLIC_API_BASE_URL= npm run build
```

`web.env` on the server holds only `PORT` and `HOSTNAME`.

---

## 4. Deploying new files and restarting

### The whole thing, one command [local]

```bash
export MTMS_HOST=user@your-server
./scripts/release.sh deploy
```

That builds both, runs the tests, packages, copies, restarts on the server and checks it came
back up.

### Or in two halves

**Build and package** [local]:

```bash
./scripts/release.sh package
```

Produces exactly two artefacts:

```
mtms-backend/target/mtms-api-1.0.0-SNAPSHOT.jar
mtms-frontend/mtms-frontend.tar.gz
```

**Copy them up** [local]:

```bash
scp "mtms-backend/target/$JAR" "$MTMS_HOST:~/mtms/backend/"
scp "mtms-frontend/$WEB"        "$MTMS_HOST:~/mtms/frontend/"
```

**Restart** [server]:

```bash
cd ~/mtms && ./release.sh restart
```

That stops both, unpacks the frontend tarball, sources `mtms.env`, starts both, waits, and runs
the status check.

### The same thing by hand [server]

If `release.sh` is not on the server, this is what it does:

```bash
# 1. Stop. -u $USER so this cannot reach another account's processes on a shared box.
pkill -u $USER -f mtms-api-1.0.0-SNAPSHOT.jar
pkill -u $USER -f "node.*server.js"
sleep 2

# 2. Unpack the web app. The tarball contains dist-frontend/, so remove the old one first —
#    tar will merge into it otherwise and leave stale chunks behind that nothing serves but
#    that make the directory listing lie about which build is there.
cd $WEB_DIR && rm -rf dist-frontend && tar -xzf mtms-frontend.tar.gz

# 3. Start the API
cd $API_DIR && set -a && . ./mtms.env && set +a
nohup java -jar $JAR > api.log 2>&1 &

# 4. Start the web app. It MUST run from inside dist-frontend — server.js resolves
#    .next/static relative to its own directory, and started from anywhere else the page
#    renders with no CSS and no JS, which reads as a broken build.
cd $WEB_DIR/dist-frontend
PORT=$WEB_PORT HOSTNAME=0.0.0.0 nohup node server.js > ../web.log 2>&1 &

# 5. Check. Twelve seconds is what this server has needed.
sleep 12 && cd ~/mtms && ./release.sh status
```

### Under systemd

```bash
sudo systemctl restart mtms-api mtms-web
systemctl status mtms-api mtms-web
```

Replacing the JAR still needs a restart — the file is opened at start and the running process
keeps the old one.

### Rolling back

```bash
# Keep the previous jar before overwriting it:
cp $API_DIR/$JAR $API_DIR/mtms-api.previous.jar
```

Both programs are stateless, so a rollback is: put the old files back and restart. **The
database is not rolled back** — check whether the release you are undoing changed the schema
before assuming it is safe.

---

## 5. Building

**Both, with the tests** [local]:

```bash
./scripts/release.sh build
```

**API only** [local]:

```bash
cd mtms-backend
./mvn.sh package                    # runs the tests
./mvn.sh -DskipTests package        # re-package something already tested
./mvn.sh clean package              # when a stale target/ is suspected
```

> Always `./mvn.sh`, never `mvn`. This machine's `java` is a JDK 8 and its `mvn` is 3.0.5, and
> Spring Boot 3 builds with neither. The script points at `~/.jdks/ms-21.0.10` and a modern
> Maven for the length of one command, without changing PATH for the other tooling here.
> Override with `MTMS_JAVA_HOME` / `MTMS_MAVEN_HOME`.

> Also note `mvn` appears to succeed while doing nothing: `Nothing to compile - all classes are
> up to date` after an edit means the incremental check was fooled. `./mvn.sh clean compile`.

**Web app only** [local]:

```bash
cd mtms-frontend
npm ci                                          # first time, or after package.json changes
rm -rf .next
NEXT_PUBLIC_API_BASE_URL= npm run build
```

The empty `NEXT_PUBLIC_API_BASE_URL` is deliberate and is the tested setup: it makes every call
from the browser relative, so this server proxies them. One build then works on localhost, on a
bare IP and on a domain later, with no CORS and one open port.

**Package the frontend for the server** [local]:

```bash
cd mtms-frontend
rm -rf dist-frontend mtms-frontend.tar.gz
mkdir dist-frontend
cp -a .next/standalone/. dist-frontend/
cp -a .next/static dist-frontend/.next/static
cp -a public dist-frontend/public 2>/dev/null || true
tar -czf mtms-frontend.tar.gz dist-frontend
```

> The `.next/static` copy is **not optional** and Next.js does not do it for you. Miss it and
> the app serves HTML with no CSS and no JS. `release.sh package` also copies `public/`, which
> `com.txt` did not.

---

## 6. Running it locally

**API** [local]:

```bash
cd mtms-backend && ./mvn.sh spring-boot:run
```

Starts on **6011** with in-memory storage, no MySQL, no Redis, no Kafka.

Against a real MySQL instead:

```bash
cd mtms-backend && ./mvn.sh spring-boot:run -Dspring-boot.run.profiles=mysql
```

**Web app** [local]:

```bash
cd mtms-frontend && npm run dev
```

> **Port 3000, not 6010.** `npm run dev` is `next dev -p 3000` and `npm start` is
> `next start -p 3000`. Only the packaged standalone server reads `PORT`, which is why the
> server runs on 6010 and your laptop does not. Open <http://localhost:3000>.

**Signing in locally.** `com.txt` recorded `parmahaj@mahajan.com` / `tracker`, which works only
against a database that still has the old seed data. **A fresh database has no accounts at
all** — the seeder was deleted on 16 Sept. See §9.

**Running the built JAR directly** [local] — note the full path to Java 21, since `java` on
PATH is 8:

```bash
~/.jdks/ms-21.0.10/bin/java -jar mtms-backend/target/mtms-api-1.0.0-SNAPSHOT.jar \
  --server.port=6099 \
  --mtms.security.jwt-secret=dev-only-secret-do-not-use-in-production-0123456789
```

Stopping it on Windows, where `pkill` does not reach it:

```powershell
Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
  Where-Object { $_.CommandLine -like '*mtms-api*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

---

## 7. Tests

```bash
# [local] backend — 75 tests
cd mtms-backend && ./mvn.sh test

# one class
cd mtms-backend && ./mvn.sh test -Dtest=StepGateTest

# [local] frontend — 31 tests
cd mtms-frontend && npx vitest run
cd mtms-frontend && npx vitest            # watch

# [local] types. --incremental false, or it trusts a stale tsbuildinfo and says nothing
cd mtms-frontend && npx tsc --noEmit --incremental false
```

**The integration tests need a database and skip silently without one.** 25 of them. Start the
throwaway MySQL first (§8) — until then the whole JDBC step layer has never executed:

```bash
cd mtms-backend
./scripts/mysql-dev.sh up
./mvn.sh test                             # the 25 now run instead of skipping
```

---

## 8. Database

**A throwaway MySQL for development** [local]. Docker cannot pull images on this network, so
this downloads the standalone server zip — no install, no admin rights. Port **13306**:

```bash
cd mtms-backend
./scripts/mysql-dev.sh up          # download if needed, initialise, start
./scripts/mysql-dev.sh schema      # create the schema and run the migration
./scripts/mysql-dev.sh cli         # a mysql prompt on it
./scripts/mysql-dev.sh down        # stop
./scripts/mysql-dev.sh clean       # stop and delete the data directory
```

**Creating the schema and user on a real server** [server]:

```sql
CREATE DATABASE mtms CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'mtms'@'localhost' IDENTIFIED BY 'put-a-real-password-here';
ALTER  USER 'mtms'@'localhost' IDENTIFIED BY 'put-a-real-password-here';
GRANT ALL PRIVILEGES ON mtms.* TO 'mtms'@'localhost';
FLUSH PRIVILEGES;
```

> `'mtms'@'localhost'` when the database is on the same machine as the API, `'mtms'@'%'` when
> it is not. MySQL treats the host as part of the identity, so a user created for one is
> refused from the other.

**Prove the credentials before starting the app**, where the error is one line rather than the
end of a stack trace:

```bash
mysql -u mtms -p -e "SHOW DATABASES;"
```

**Backups.** The database is the only thing that cannot be rebuilt — both programs come back
from git in two minutes, and since the seeder was removed, a lost database is a locked door.

```bash
mysqldump -u mtms -p --single-transaction --routines mtms > mtms-$(date +%F).sql
mysql -u mtms -p mtms < mtms-2026-09-16.sql        # restore
```

**Did the migration run?**

```bash
mysql -u mtms -p mtms -e "SELECT version, description, success FROM flyway_schema_history;"
mysql -u mtms -p mtms -e "SHOW TABLES;" | wc -l     # expect 37 (36 tables + the header)
```

---

## 9. First account on an empty database

An empty database is a closed circle: there is no self sign-up, every account comes from an
invitation, and with nobody inside, nobody can be invited. The service still starts cleanly and
the health check is green — **and no password gets you in.**

```bash
# 1. Start the API once so Flyway builds the 36 tables.
# 2. Edit the values at the top of deploy/bootstrap.sql — especially @invite_token.
# 3. Run it:
mysql -u mtms -p mtms < deploy/bootstrap.sql
```

It prints an accept-invite link. Open it, choose a password, sign in. It does not set a
password itself — passwords are scrypt-hashed by the application and SQL cannot do that, so it
writes an *invitation* exactly as the console would.

**Reissuing a lost invitation** is a button on `/platform`, on any row marked *invited*. There
is no command for it and no query that can recover the original: the server stores only a hash.

---

## 10. When something is wrong

| Symptom | Command | What it means |
|---|---|---|
| `status` says `000` | `pgrep -af mtms-api` | Nothing is listening. The process is not running — read `api.log` from the top |
| `UnsupportedClassVersionError` | `java -version` | Java is not 21 |
| `Access denied for user` | `. $ENV_FILE; echo "$DATABASE_URL"` | Usually the unquoted-URL trap (§3), not the password |
| `Communications link failure` | `mysql -u mtms -p -e "SELECT 1"` | MySQL is not listening where the URL says, or is refusing this host |
| `jwt-secret must be at least 32 characters` | `grep JWT $ENV_FILE` | Missing or short |
| Health says `DOWN`, app works | `grep -i redis $API_DIR/api.log` | The `mysql` profile switched Redis on. `SPRING_AUTOCONFIGURE_EXCLUDE` in §3 of `DEPLOYMENT.md` |
| Login bounces back, nothing logged | `grep SECURE_COOKIES $ENV_FILE` | `true` over plain HTTP. The browser silently drops the cookie |
| Page loads, no styling | `ls $WEB_DIR/dist-frontend/.next/static` | `.next/static` was not copied into the bundle |
| Matrix empty, browser console shows CORS | `grep CORS $ENV_FILE` | The allowed origin is not the address the browser typed |
| Invitation link has the domain twice | — | Fixed 16 Sept. An old build |
| `Migration checksum mismatch` | `git log -p -- mtms-backend/src/main/resources/db/migration/` | Something edited `V1` after this database ran it. Find what before repairing anything |

**Nothing at all in the log and the process is gone** — it died before logging could start.
Run it in the foreground and watch:

```bash
cd $API_DIR && set -a && . ./mtms.env && set +a && java -jar $JAR
```

---

## What this replaces

`com.txt`. Everything in it is here, with four things it did not have:

- **`jobs -l` does not work** for checking whether the app is running — it only sees jobs
  started by the current shell, so it prints nothing after an SSH reconnect. §1 uses `pgrep`.
- **`public/` was never copied** into the frontend bundle.
- **`-DskipTests` was the default**, so a release could ship without the suite ever running.
- **No way to check** whether a setting actually took, which is the whole of §3.
