# mtms-backend

The MTMS API. Spring Boot 3.3.5 on Java 21.

## Running it

Neither the JDK nor the Maven this needs is on this machine's PATH — `java` resolves to a
JDK 8 from 2022 and `mvn` to Maven 3.0.5 from 2013, and Spring Boot 3 builds with neither.
`mvn.cmd` / `mvn.sh` point at the right pair for the length of one command rather than
changing a PATH that other Nokia tooling depends on.

```bash
./mvn.sh test              # 39 tests, no database needed
./mvn.sh spring-boot:run   # http://localhost:8080
```

Sign in as `parmahaj@mahajan.com` / `tracker`. The demo organisation is seeded on first start.

**The build is offline.** This machine reaches neither Maven Central nor the Nokia mirror,
so every dependency is pinned to something already in `~/.m2` and `.mvn/maven.config`
passes `-o`. A version bump is therefore not a free action — check the local repository
first, or the build stops.

## The shape of it

Four layers, and the arrows only point one way:

```
api  ─────────┐
              ├──▶  application  ──▶  domain
infrastructure ┘                       (depends on nothing)
```

- **`domain`** is the rules: the status vocabulary, the roll-up, readiness, the promotion
  gate, the drift verdicts. No Spring, no SQL, no clock — `now` is a parameter. This is the
  half with a paired implementation in TypeScript, and keeping it pure is what makes the two
  comparable.
- **`application`** owns the use cases and declares *ports* — interfaces it needs somebody to
  satisfy. Permissions are enforced here, in the use case, never in a controller.
- **`infrastructure`** satisfies those ports with storage, Redis, Kafka, scrypt and JWTs.
- **`api`** is the HTTP boundary and holds no rules at all. Controllers are ten lines: parse,
  call a use case, return the snapshot.

That direction is the whole design. It is why the use cases can be tested against in-memory
ports in milliseconds, why Redis and Kafka are genuinely optional with no `if` in any use
case, and why swapping the storage engine is a new class rather than a rewrite.

## What is deliberate

**Every mutation returns the whole snapshot.** A click is one round trip, not a write plus
three refetches, and there is no client-side cache to keep coherent.

**The snapshot is cached per (tenant, project, user, revision).** The revision is the clever
part: after any write it moves, so the old key is unreachable and a stale read is impossible.
There is no invalidation code to get wrong because there is no invalidation. The user is in
the key because a snapshot carries that user's permissions — sharing one across users would
serve an admin's view to a viewer.

**Permissions are read on every request, never carried in the token.** One indexed query,
and removing somebody's access takes effect on their next click rather than whenever their
token expires.

**A replayed refresh token revokes its whole family.** If a token that has already been spent
comes back, either the legitimate holder is retrying or somebody stole it. Nothing in the
request says which, so both sign in again.

**Events go through an outbox.** Writing to Kafka inside a transaction makes the database
write and the publish two things that can disagree. They are inserted into `domain_events` in
the same transaction and drained afterwards, at-least-once.

**Gates are recomputed server-side.** The client renders the FNI and promotion gates and
disables the buttons, but a request arriving with a gate closed is refused regardless of what
the button looked like.

## Configuration

| Profile | Storage | Cache | Events |
|---|---|---|---|
| default | in-memory, seeded | local map | logged |
| `postgres` | Postgres + Flyway | Redis | Kafka |

```bash
./mvn.sh spring-boot:run -Dspring-boot.run.profiles=postgres
```

`mtms.security.jwt-secret` has no usable default and the application refuses to start
without one of at least 32 characters. A signing key with a default is a signing key every
deployment shares.

## Status

**Verified by running it.** Auth (including that a wrong password and an unknown account
return the identical message), the snapshot projection, cell editing and the audit trail it
writes, permission enforcement — a viewer gets 403 on both a cell edit and an FNI sign-off —
the FNI gate refusing an incomplete module, the drift verdicts and the promotion gate, and
the whole thing rendered by `mtms-frontend` over CORS with cookies. 39 Java tests pass.

**Written but never executed: the JDBC adapter.** `infrastructure/persistence/jdbc/` now
implements every repository port, and it compiles. It has never run against a real Postgres,
because there is none on this machine and the network to fetch one is blocked — Docker is
installed but its daemon is not running and the image could not be pulled anyway.

Treat that code as unverified. The parts most likely to be wrong are the ones that could not
be checked by the compiler:

- the two `ON CONFLICT ... WHERE` clauses in `JdbcModuleRepository.upsertCell`, which depend
  on Postgres inferring a *partial* unique index from a repeated predicate;
- `IS NOT DISTINCT FROM` for the nullable `subactivity_id`;
- the `?::jsonb` casts and the `text[]` binding via `createArrayOf`;
- `FOR UPDATE SKIP LOCKED` in the outbox drain.

Each is commented where it appears with what it is doing and why the obvious alternative is
wrong. The first thing to do with a database available is `./mvn.sh spring-boot:run
-Dspring-boot.run.profiles=postgres` and then exercise the same flows the default profile has
already been through.

The default in-memory storage is what actually runs today: durable for the life of the
process, single instance, no transactions across two collections. That is the honest ceiling
of the profile, and it is why the postgres one exists.
