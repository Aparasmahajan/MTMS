# MTMS API — the Spring Boot port

The design bundle targets Spring Boot on the back end. Today the API is Next.js route
handlers in `app/api/v1/`. This module is where that moves, and it is deliberately started
from the middle rather than the edges.

**Nothing here has been compiled.** There is no JDK or Maven on the development machine.

## Why this file first

`StatusVocabulary.java` is a port of `lib/shared/vocabulary.ts` — the roll-up rule,
readiness, stage bucketing, and the click-to-advance cycle.

It is first because it is the only code whose behaviour *must* be identical in both
implementations. Two services can differ in structure, framework and style without anyone
caring. If they differ in what "58%" means, the matrix stops being evidence and the
application has no reason to exist.

`StatusVocabularyTest.java` runs the same truth table as
`lib/shared/__tests__/vocabulary.test.ts`, case for case. Keep that correspondence: when a
rule changes, both files change together, and the paired tests are what makes a one-sided
change fail loudly.

Two subtleties the port has to get right, both commented in the source:

- **Rounding.** `Math.round` on a double is half-up in Java, which matches JavaScript's
  `Math.round`. `RoundingMode.HALF_EVEN` would disagree at exactly the `.5` boundaries — a
  project with 8 counted columns and 4 done would report 50 in one service and 50 in the
  other by luck, and a different split would not.
- **A blank is `""`, never `null`.** Making it nullable invites a `COALESCE` or an
  `Optional.orElse("notloaded")` somewhere, and the difference between "not done" and
  "nobody recorded it" is the distinction the whole application is built on.

## What the port still needs

In rough order:

1. **The HTTP boundary.** `contracts/openapi.yaml` is the contract both implementations
   answer to. Generate the DTOs from it rather than hand-writing them twice.
2. **Auth.** Email and password, scrypt or argon2, the same short access token plus a
   rotating refresh token with replay detection (`lib/server/sessions.ts` has the rule:
   a spent token revokes its whole family).
3. **Permissions.** The 17 keys in `lib/shared/permissions.ts`, checked server-side on
   every request. The client's copy exists only to disable controls.
4. **The projection.** `buildSnapshot` assembles the whole project in one pass. In SQL that
   is a handful of indexed reads plus the same derivation — see `schema.sql`.
5. **The FNI gate and the promotion gate.** Both must be recomputed from the store, never
   trusted from the client. `lib/shared/promotion.ts` is already framework-free and ports
   almost line for line.
6. **The outbox.** `domain_events` in `schema.sql`, drained to Kafka. Spring's
   `@Transactional` makes the write-and-record atomic more naturally than the Node version
   manages.

## Running it, once there is a JDK

```bash
cd services/api-java
./mvnw test          # StatusVocabularyTest first — it is the contract
./mvnw spring-boot:run
```
