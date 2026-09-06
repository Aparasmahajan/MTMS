# MTMS — three repositories

The tracker, split into the three programs it was always going to become.

```
tracker/
├── mtms-backend/    Spring Boot 3.3.5, Java 21        :8080
├── mtms-frontend/   Next.js 14, talks to the API      :3000
├── mtms-static/     Next.js exported to static files  :4173
└── mtms/            the original, single-process app  :3100
```

`mtms/` is left exactly as it was. Nothing in the three new directories imports from it, and
it still runs; it is the reference the port was made against, not a dependency.

## Which one do you want

| | mtms-backend + mtms-frontend | mtms-static |
|---|---|---|
| Needs a server | yes | no |
| Real accounts and permissions | yes, enforced | mirrored, for show |
| Edits persist | yes | yes, in your browser |
| Two people see the same board | yes | **no** |
| Deploys to | a JVM host and a Node host | any static host, or a USB stick |

That fourth row is the whole reason there are two front ends. `mtms-static` keeps your edits
in `localStorage` and pushes them to your other tabs over a `BroadcastChannel`, which is as
far as a page with no server can go — a second person on a second machine has a separate
store and there is nothing between them. Sharing across people needs the API.

## Running the real pair

```bash
cd mtms-backend  && ./mvn.sh spring-boot:run    # :8080, seeds the demo org on first start
cd mtms-frontend && npm run dev                 # :3000
```

Sign in as `parmahaj@mahajan.com` / `tracker`.

## Running the static one

```bash
cd mtms-static && npm run build && npm run serve   # :4173
```

Open it in two tabs and edit a cell in one.

## What is actually finished

Verified by running it: authentication and refresh-token rotation, the snapshot projection,
cell editing and the audit trail, module and subactivity editing, defects, project
configuration, drift reports, promotions and the promotion gate, members, invitations, role
grants, the FNI gate, and server-side permission enforcement (a viewer gets 403, not a hidden
button). 39 tests in Java, 22 in TypeScript over the same truth table, 4 in a real browser for
the static build.

**One real gap.** `mtms-backend`'s JDBC/Postgres adapter is written and compiles but has never
run — there is no Postgres on this machine and the network to fetch one is blocked. The
default in-memory storage is what works today: single instance, and gone when the process
stops. `mtms-backend/README.md` lists exactly which statements to distrust first.

## Notes on this machine

Neither the JDK nor the Maven the backend needs is on PATH, and there is no route to Maven
Central. `mtms-backend/mvn.sh` points at the right JDK 21 and Maven 3.9.9 for one command, and
`.mvn/maven.config` builds offline against what is already in `~/.m2`. Bumping a dependency
version is therefore not free — check the local repository first.

`node_modules` in the two front ends were installed from the npm cache for the same reason.
