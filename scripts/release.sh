#!/usr/bin/env bash
#
# MTMS — build, package, deploy.
#
# This replaces the loose commands that lived in com.txt. They were correct; the problem was
# that they were nine commands in a text file, so every release depended on somebody pasting
# all nine in the right order and noticing if the fourth one failed. Three of them are
# destructive (`rm -rf`, `pkill`) and one of them is silently order-dependent — the frontend
# tarball is built from `.next/standalone`, which only exists after the build that precedes it.
#
# Usage, from anywhere:
#
#   ./scripts/release.sh build      # compile both, run the tests
#   ./scripts/release.sh package    # build, then produce the two artefacts to copy up
#   ./scripts/release.sh deploy     # package, then scp + restart on $MTMS_HOST
#   ./scripts/release.sh restart    # (on the server) stop, unpack, start, verify
#   ./scripts/release.sh status     # (anywhere) is it up
#
# Nothing here writes to a server unless you ask for `deploy`, and `deploy` refuses without
# MTMS_HOST set — a deploy that guesses where to deploy is not a convenience.

set -euo pipefail

# -e alone is not enough: a failure inside a pipeline would otherwise be masked by the exit
# status of the last command in it, which is exactly how "BUILD FAILURE | tail" reports success.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/mtms-backend"
FRONTEND="$ROOT/mtms-frontend"

JAR_NAME="mtms-api-1.0.0-SNAPSHOT.jar"

# Where things live on the server. Overridable, because a second environment should not need
# a second copy of this script.
REMOTE_DIR="${MTMS_REMOTE_DIR:-\$HOME/mtms}"
API_PORT="${MTMS_API_PORT:-6011}"
WEB_PORT="${MTMS_WEB_PORT:-6010}"

# The private hop the web server uses to reach the API. Compiled into the frontend by
# `next build` — Next.js evaluates rewrites() at build time and writes the result into
# routes-manifest.json, so setting this at `npm start` does nothing. This is the one value
# that genuinely has to be decided here rather than at run time.
API_PROXY_TARGET="${API_PROXY_TARGET:-http://localhost:$API_PORT}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1merror: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------

build_api() {
  say "Building the API"
  cd "$BACKEND"

  # Tests run here, not skipped. com.txt passed -DskipTests, which is the right call when you
  # are re-packaging an artefact you already tested and the wrong one as a default: the whole
  # suite is under ten seconds, and the failure it catches is a release that does not start.
  # MTMS_SKIP_TESTS=1 for the re-package case.
  if [ "${MTMS_SKIP_TESTS:-0}" = "1" ]; then
    ./mvn.sh -q -DskipTests package
  else
    ./mvn.sh -q package
  fi

  [ -f "$BACKEND/target/$JAR_NAME" ] || die "the build produced no $JAR_NAME"
  say "API built — $(du -h "$BACKEND/target/$JAR_NAME" | cut -f1)"
}

build_web() {
  say "Building the web app"
  cd "$FRONTEND"

  [ -d node_modules ] || npm ci

  # An EMPTY public API address is deliberate and is the setup that was tested. It makes every
  # call from the browser relative — /api/v1/... on the web port — which this server then
  # forwards to the API. Four things follow: no domain is compiled in, so one build works on
  # localhost, on an IP and on a domain later; there is no CORS, because it is one origin;
  # login works over plain HTTP, because a same-origin cookie needs no SameSite=None; and only
  # one port has to be open.
  rm -rf .next
  API_PROXY_TARGET="$API_PROXY_TARGET" NEXT_PUBLIC_API_BASE_URL= npm run build

  [ -d .next/standalone ] || die "no .next/standalone — is output: 'standalone' still in next.config.mjs?"
  say "Web app built"
}

package() {
  build_api
  build_web

  say "Packaging"
  cd "$FRONTEND"

  # The standalone output does NOT include .next/static or the public assets; Next.js leaves
  # copying them to the deployer. Miss this and the app serves HTML with no CSS and no JS,
  # which looks like a broken build rather than a missing copy.
  rm -rf dist-frontend mtms-frontend.tar.gz
  mkdir dist-frontend
  cp -a .next/standalone/. dist-frontend/
  cp -a .next/static dist-frontend/.next/static
  [ -d public ] && cp -a public dist-frontend/public

  tar -czf mtms-frontend.tar.gz dist-frontend

  say "Two artefacts to copy up:"
  printf '  %s\n' "$BACKEND/target/$JAR_NAME"
  printf '  %s\n' "$FRONTEND/mtms-frontend.tar.gz"
}

deploy() {
  [ -n "${MTMS_HOST:-}" ] || die "set MTMS_HOST=user@server first. A deploy that guesses where is not a convenience."
  package

  say "Copying to $MTMS_HOST"
  ssh "$MTMS_HOST" "mkdir -p $REMOTE_DIR/frontend"
  scp "$BACKEND/target/$JAR_NAME" "$MTMS_HOST:$REMOTE_DIR/"
  scp "$FRONTEND/mtms-frontend.tar.gz" "$MTMS_HOST:$REMOTE_DIR/frontend/"
  scp "$ROOT/scripts/release.sh" "$MTMS_HOST:$REMOTE_DIR/"

  say "Restarting on $MTMS_HOST"
  ssh "$MTMS_HOST" "cd $REMOTE_DIR && bash release.sh restart"
}

# ---------------------------------------------------------------------------
# Server side
# ---------------------------------------------------------------------------

restart() {
  # Expects to be run from the directory holding the jar, api.env and frontend/.
  local here
  here="$(pwd)"

  [ -f "$here/$JAR_NAME" ] || die "no $JAR_NAME here. Run this from $REMOTE_DIR on the server."
  [ -f "$here/api.env" ] || die "no api.env here — see DEPLOYMENT.md section 3 for what goes in it."

  say "Stopping"
  # -u $USER, so this cannot reach another account's processes on a shared box.
  pkill -u "$USER" -f "$JAR_NAME" || true
  pkill -u "$USER" -f "node.*server.js" || true
  sleep 2

  say "Unpacking the web app"
  cd "$here/frontend"
  rm -rf dist-frontend
  tar -xzf mtms-frontend.tar.gz

  say "Starting the API"
  cd "$here"
  # `set -a` exports everything the file defines. Quoting inside api.env still matters —
  # DATABASE_URL contains `&`, and unquoted it runs as three commands and never gets set.
  set -a
  # shellcheck disable=SC1091
  . ./api.env
  set +a
  nohup java -jar "$JAR_NAME" > api.log 2>&1 &

  say "Starting the web app"
  cd "$here/frontend/dist-frontend"
  PORT="$WEB_PORT" HOSTNAME=0.0.0.0 nohup node server.js > ../web.log 2>&1 &

  # Flyway runs on the API's first start and the JVM is not quick. Ten seconds is enough for
  # both to be answering; the check below is what actually decides.
  sleep 10
  cd "$here"
  status
}

status() {
  local api web
  api=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/actuator/health" || echo 000)
  web=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$WEB_PORT/login" || echo 000)

  printf '\n  api  %s  http://localhost:%s/actuator/health\n' "$api" "$API_PORT"
  printf '  web  %s  http://localhost:%s/login\n\n' "$web" "$WEB_PORT"

  if [ "$api" != "200" ] || [ "$web" != "200" ]; then
    # Naming the log is the whole value of failing here rather than printing two numbers: the
    # answer is always in the last Caused by: of one of these two files.
    printf 'Not healthy. The reason is in the last "Caused by:" of api.log or in web.log.\n\n' >&2
    return 1
  fi
  say "Both up"
}

# ---------------------------------------------------------------------------

case "${1:-}" in
  build)   build_api; build_web ;;
  package) package ;;
  deploy)  deploy ;;
  restart) restart ;;
  status)  status ;;
  *)
    cat <<USAGE
MTMS release

  ./scripts/release.sh build      compile both, run the tests
  ./scripts/release.sh package    build, then produce the jar and the frontend tarball
  ./scripts/release.sh deploy     package, copy to \$MTMS_HOST, restart there
  ./scripts/release.sh restart    (on the server, from ~/mtms) stop, unpack, start, verify
  ./scripts/release.sh status     is it up

Environment:
  MTMS_HOST           user@server — required for deploy
  MTMS_REMOTE_DIR     where it lives on the server (default: \$HOME/mtms)
  MTMS_API_PORT       default 6011
  MTMS_WEB_PORT       default 6010
  API_PROXY_TARGET    where the web server reaches the API (default: http://localhost:6011)
                      Compiled in at build time — see DEPLOYMENT.md section 4.
  MTMS_SKIP_TESTS=1   re-package without running the suite
USAGE
    exit 1
    ;;
esac
