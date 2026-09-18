# Deploying MTMS

Two programs. The **API** is a Spring Boot JAR on port 6011. The **web app** is a Next.js
server on port 6010. They talk over HTTP, so they can sit on one machine or two.

Both were built and checked together on 14 Sept 2026 — see *What was verified* at the end,
which is also honest about what was not.

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

The schema `mtms` already exists. The application creates its own 36 tables inside it on
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
```

Then open `http://YOUR-SERVER:6010` in a browser and sign in. You should see **18
sub-modules across 6 modules** and a matrix of **26 columns**. If the page loads but the
matrix is empty, it is trap 1 or trap 4 above — open the browser's developer console, which
will say which.

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

---

## What was verified, and what was not

**Verified on 14 Sept 2026, against a real MySQL 8.0.40:**

- The JAR builds and all **62 tests pass**, including 16 that run only when a MySQL server
  is present.
- Starting against an **empty `mtms` schema** creates all 36 tables and seeds the sample
  organisation. Verified by dropping and recreating the schema first, so this is the same
  path your server will take on its first start.
- Login as `paras.mahajan@azalio.io`, the project snapshot and the super admin console all
  return correct data read from MySQL — 18 sub-modules, 26 columns, 9 users, 3 projects,
  with each project's administrators listed.
- The old `nitin@azalio.io` account is gone and is refused.
- **Writes persist.** Changing a cell through the running app stores the new status, who
  changed it and when, and appends the audit row. Confirmed by reading the rows back out
  of MySQL directly.
- **Timestamps are stored in UTC**, as the connection settings intend.
- **Text is stored as UTF-8.** An arrow written into the audit trail comes back as an
  arrow, not as `?`.
- The web app builds, runs, and shows that same MySQL data in the browser.

### Two bugs were found and fixed doing this

**1. The service would not start against MySQL at all.** Seeding inserted memberships
pointing at a project that did not exist yet, and MySQL rejected the foreign key. The
in-memory storage does not enforce foreign keys, which is why it had never shown up. It
would have failed on your server at startup, before serving a single request. Fixed by
creating the projects before the users in `Seeder.java` — since deleted, so this one is
history rather than something to maintain.

**2. The super admin console crashed.** The Java API never sent the list of administrators
per project — that field was added to the TypeScript back end and never ported, though the
Java file's comment claimed the two matched "field for field". The page read
`project.admins.length` on a value that was not there and died with a blank screen. This
mattered: the console is where you create projects and assign their admins, which is the
first thing you would have done. Fixed by adding `ProjectAdministrator` to `PlatformView`.

**3. An empty API address broke server-side rendering.** Relative paths are right for the
browser, but Node has no current page to be relative to, so every server-rendered page
failed with a connection refused that looked exactly like the API being down. Fixed in
`lib/client/config.ts`: the server half falls back to the proxy target while the browser
half stays relative.

The JAR in `target/` and the build in `mtms-frontend/.next` are the rebuilt ones.

**Still not verified:**

- **Redis and Kafka.** The settings in step 3 switch them off.
- **HTTPS.** Everything above ran over plain HTTP. When you add TLS, set
  `MTMS_SECURITY_SECURE_COOKIES=true` — and note trap 1 in reverse: with HTTPS in place,
  leaving it `false` is a real weakness, not just untidy.
- **Your actual server.** The MySQL used here was a local throwaway on port 13306. Host,
  credentials and firewall are the remaining unknowns.
