# deploy/

The files a server actually needs. `DEPLOYMENT.md` in the repository root is the prose —
what to do, in what order, and which four traps cost an afternoon each. This directory is the
things you copy.

| File | What it is |
|---|---|
| `bootstrap.sql` | **The first way in.** Run once against an empty schema, before anything else |
| `api.env.example` | The API's environment. Copy to `api.env` beside the JAR, or `/etc/mtms/api.env` |
| `web.env.example` | The web app's environment. Short, because almost everything is compiled in |
| `systemd/mtms-api.service` | Runs the JAR, restarts it on failure, stops it gracefully |
| `systemd/mtms-web.service` | Same for the Next.js server |
| `nginx/mtms.conf` | HTTPS in front, forwarding to port 6010 only |

Building and shipping is `scripts/release.sh` at the root, not here — `build`, `package`,
`deploy`, `restart`, `status`.

---

## Start here, on a fresh machine

```bash
# 1. Schema and user
mysql -u root -p -e "CREATE DATABASE mtms CHARACTER SET utf8mb4"
mysql -u root -p < /dev/stdin <<'SQL'
CREATE USER IF NOT EXISTS 'mtms'@'localhost' IDENTIFIED BY 'put-a-real-password-here';
ALTER  USER 'mtms'@'localhost' IDENTIFIED BY 'put-a-real-password-here';
GRANT ALL PRIVILEGES ON mtms.* TO 'mtms'@'localhost';
FLUSH PRIVILEGES;
SQL

# 2. Environment
cp deploy/api.env.example ~/mtms/api.env         # fill in the four marked CHANGE
cp deploy/web.env.example ~/mtms/frontend/web.env

# 3. Start the API once, so Flyway builds the 36 tables
./scripts/release.sh restart

# 4. NOW bootstrap. The schema has to exist first.
#    Edit the values at the top, then:
mysql -u mtms -p mtms < deploy/bootstrap.sql
#    It prints an accept-invite link. Open it, choose a password, sign in.
```

Step 4 is the one nobody expects, and skipping it produces the most confusing possible
outcome: everything starts cleanly, the health check is green, and **no password gets you in**.

## Why step 4 exists

The demo seeder was deleted on 16 Sept, once the real database was populated, and nothing
replaced it. There is no self sign-up, and every account is created by an invitation from
somebody who is already an administrator — so an empty database is a closed circle: nobody is
inside, therefore nobody can be invited.

`bootstrap.sql` breaks it with the smallest thing the application can start from — one
organisation, one admin role, one invited super admin, one empty project.

Three things about it worth knowing before you run it:

- **It does not set a password.** Passwords are scrypt-hashed by the application and SQL
  cannot do that. So it writes an *invitation*, exactly as the console would, and you finish
  in the browser. The token is never stored — only its SHA-256 — which means the value you put
  in the file is the only copy that will ever exist.
- **It creates a project you did not ask for.** Not tidiness: `ActorFactory` resolves a project
  for every request, including the ones with no project, and throws *"This organisation has no
  projects yet"* when there are none. An organisation without one is an organisation nobody can
  sign in to.
- **The account it makes is a super admin**, and this is the only place in the whole system
  that sets that flag — no screen can. That is deliberate: every *permission* is granted by a
  role an organisation's own admin may edit, so if "create organisations" were one of them, any
  admin could grant it to themselves.

Once a real organisation exists at `/platform`, delete the bootstrap one if it was only a way
in.

## Backing up

The database, and nothing else. Both programs are stateless and rebuild from git in two
minutes. What cannot be rebuilt is the ability to sign in — since the seeder went, a lost
database is a locked door, and `bootstrap.sql` only helps on an *empty* schema.

The one thing that is deliberately not backed up: the invitation links the console keeps under
"Invitation links issued here" live in one browser's `localStorage`. They do not need saving —
an unaccepted invitation can be reissued from the same screen — but do not treat that list as a
record of anything.
