# mtms-frontend

The MTMS user interface. Next.js 14, and nothing else — every `/api/v1/...` path is served
by the Spring Boot service in `../mtms-backend`.

## Running it

The API has to be up first.

```bash
cd ../mtms-backend && ./mvn.sh spring-boot:run     # :8080
cd ../mtms-frontend && npm run dev                 # :3000
```

Sign in as `parmahaj@mahajan.com` / `tracker`.

Copy `.env.example` to `.env.local` if the service is anywhere other than
`http://localhost:8080`.

## What changed when the API moved out

Three things, and they are the only interesting parts of this repository.

**`lib/client/api.ts` sends every request cross-origin with credentials.** A cross-origin
fetch omits cookies unless you ask, and the failure mode looks exactly like being logged out
rather than like a configuration mistake — so `credentials: 'include'` is not optional, and
the service must name this origin in `mtms.cors.allowed-origins`. A wildcard will not do:
the browser refuses `Allow-Origin: *` together with credentials.

**`lib/client/session.ts` forwards cookies from server components.** Pages under the app
shell are server-rendered, and `fetch` inside a server component has no cookie jar — it is a
separate program making its own outbound request. The session cookies are attached by hand.
Forgetting this does not fail loudly; the service simply answers 401 and every page bounces
to the login screen for no visible reason.

**The demo runtime is gone.** It lives in `../mtms-static` now. `isDemo` is still on the
tracker context and always false, because several screens branch on it — that keeps those
screens compiling unchanged against both this provider and the static one.

## What is not here

`lib/server`, `app/api` and the Java module. This repository has no server-side rules and no
database access; deleting them was the point of the split. The permission checks that used to
be a few directories away are now across an HTTP boundary and enforced in the service's use
cases, which is where they always belonged.

`lib/shared` stays. Readiness, the roll-up and the promotion gate are computed here too — for
optimistic updates and for the disabled state of controls — from the same functions the Java
service ports. That duplication is deliberate and it is why `lib/shared/__tests__` and
`StatusVocabularyTest.java` run the same truth table: if the two ever disagree about what
100% means, both suites are supposed to notice.

## Checks

```bash
npm run typecheck   # clean
npm test            # 22 tests — the shared vocabulary truth table
npm run build       # 15 routes
```
