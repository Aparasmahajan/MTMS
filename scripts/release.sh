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

# Where things live on the server.
#
# These defaults are HRMSPRODUCTION's actual layout, not a guess: the JAR and its environment
# file sit in ~/mtms/backend, the web bundle in ~/mtms/frontend, and the environment file is
# called mtms.env rather than api.env. Every one is overridable, because the point of putting
# them here is that a second environment needs different values, not a second copy of the
# script.
REMOTE_DIR="${MTMS_REMOTE_DIR:-\$HOME/mtms}"
API_DIR="${MTMS_API_DIR:-\$HOME/mtms/backend}"
WEB_DIR="${MTMS_WEB_DIR:-\$HOME/mtms/frontend}"
ENV_FILE="${MTMS_ENV_FILE:-mtms.env}"
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
  ssh "$MTMS_HOST" "mkdir -p $API_DIR $WEB_DIR"
  scp "$BACKEND/target/$JAR_NAME" "$MTMS_HOST:$API_DIR/"
  scp "$FRONTEND/mtms-frontend.tar.gz" "$MTMS_HOST:$WEB_DIR/"
  scp "$ROOT/scripts/release.sh" "$MTMS_HOST:$REMOTE_DIR/"
  scp "$ROOT/scripts/install-pm2.sh" "$MTMS_HOST:$REMOTE_DIR/"
  scp "$ROOT/ecosystem.config.js" "$MTMS_HOST:$REMOTE_DIR/"

  # Checksums, before anything is restarted.
  #
  # Not belt and braces. A transfer to this server once arrived as "Invalid or corrupt
  # jarfile" while reporting a byte count that matched exactly, so size proves nothing and
  # the failure surfaces as a service that will not start — ten minutes after you stopped
  # the one that was working.
  say "Verifying what landed"
  local want_jar want_web
  want_jar=$(md5sum "$BACKEND/target/$JAR_NAME" | cut -d' ' -f1)
  want_web=$(md5sum "$FRONTEND/mtms-frontend.tar.gz" | cut -d' ' -f1)

  ssh "$MTMS_HOST" "md5sum $API_DIR/$JAR_NAME $WEB_DIR/mtms-frontend.tar.gz"     | grep -q "$want_jar" || die "the JAR did not survive the copy — checksum differs. Re-run; do NOT restart."
  ssh "$MTMS_HOST" "md5sum $WEB_DIR/mtms-frontend.tar.gz"     | grep -q "$want_web" || die "the frontend tarball did not survive the copy — checksum differs. Re-run; do NOT restart."
  printf '  jar %s\n  web %s\n' "$want_jar" "$want_web"

  say "Restarting on $MTMS_HOST"
  ssh "$MTMS_HOST" "cd $REMOTE_DIR && bash release.sh restart"
}

# ---------------------------------------------------------------------------
# Server side
# ---------------------------------------------------------------------------

restart() {
  # Paths, not "wherever you happen to be". The JAR and the web bundle live in two different
  # directories on this server, so a cwd-relative script would work from one of them and fail
  # confusingly from the other.
  local api_dir web_dir env_path
  api_dir="$(eval echo "$API_DIR")"
  web_dir="$(eval echo "$WEB_DIR")"
  env_path="$api_dir/$ENV_FILE"

  [ -f "$api_dir/$JAR_NAME" ] || die "no $JAR_NAME in $api_dir. Set MTMS_API_DIR if it lives elsewhere."
  [ -f "$env_path" ] || die "no $ENV_FILE in $api_dir — see deploy/api.env.example for what goes in it."
  [ -f "$web_dir/mtms-frontend.tar.gz" ] || die "no mtms-frontend.tar.gz in $web_dir."

  # Under pm2, if it is managing these apps. pm2 is what keeps the pair alive across a crash
  # and an OOM kill — a nohup process survives neither, which is what produced the 502s that
  # appeared a day or two after every release. See scripts/install-pm2.sh; this branch is
  # skipped entirely on a box where pm2 does not know about them.
  if command -v pm2 > /dev/null && pm2 describe mtms-web > /dev/null 2>&1; then
    say "Stopping (pm2)"
    pm2 stop mtms-web mtms-api

    # Unpack while they are stopped, not while they are running: server.js resolves its chunks
    # from this directory at request time, so replacing it underneath a live process serves
    # 404s for every asset until the next restart.
    say "Unpacking the web app"
    cd "$web_dir"
    rm -rf dist-frontend
    tar -xzf mtms-frontend.tar.gz

    say "Starting (pm2)"
    pm2 restart mtms-api mtms-web --update-env
    pm2 save

    sleep 12
    status
    return
  fi

  say "Stopping"
  # -u $USER, so this cannot reach another account's processes on a shared box.
  pkill -u "$USER" -f "$JAR_NAME" || true
  pkill -u "$USER" -f "node.*server.js" || true
  sleep 2

  # A port still held two seconds after the kill means the old process is not gone, and the
  # new one will exit on "Address already in use" — which lands in the log and nowhere else,
  # looking exactly like a startup fault.
  if command -v ss > /dev/null && ss -ltn 2>/dev/null | grep -qE ":($API_PORT|$WEB_PORT) "; then
    say "A port is still held — waiting"
    sleep 5
  fi

  say "Unpacking the web app"
  cd "$web_dir"
  # rm first: the tarball contains dist-frontend/, and untarring over an existing one merges
  # rather than replaces, leaving stale chunks behind that nothing will ever serve but that
  # make the directory listing lie about which build is there.
  rm -rf dist-frontend
  tar -xzf mtms-frontend.tar.gz

  say "Starting the API"
  cd "$api_dir"
  # `set -a` exports everything the file defines. Quoting inside the env file still matters —
  # DATABASE_URL contains `&`, and unquoted it runs as three commands and never gets set.
  set -a
  # shellcheck disable=SC1090
  . "$env_path"
  set +a
  nohup java -jar "$JAR_NAME" > api.log 2>&1 &

  say "Starting the web app"
  cd "$web_dir/dist-frontend"
  PORT="$WEB_PORT" HOSTNAME=0.0.0.0 nohup node server.js > ../web.log 2>&1 &

  # Flyway runs on the API's first start and the JVM is not quick. Twelve seconds is what this
  # server has needed; the check below is what actually decides.
  sleep 12
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
    if command -v pm2 > /dev/null && pm2 describe mtms-api > /dev/null 2>&1; then
      printf 'Not healthy. The reason is in the last "Caused by:":\n  pm2 logs mtms-api --lines 50 --nostream\n  pm2 logs mtms-web --lines 50 --nostream\n\n' >&2
    else
      printf 'Not healthy. The reason is in the last "Caused by:" of api.log or in web.log.\n\n' >&2
    fi
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
  MTMS_REMOTE_DIR     where release.sh itself lives (default: \$HOME/mtms)
  MTMS_API_DIR        the JAR and its env file (default: \$HOME/mtms/backend)
  MTMS_WEB_DIR        the web bundle (default: \$HOME/mtms/frontend)
  MTMS_ENV_FILE       env file name inside MTMS_API_DIR (default: mtms.env)
  MTMS_API_PORT       default 6011
  MTMS_WEB_PORT       default 6010
  API_PROXY_TARGET    where the web server reaches the API (default: http://localhost:6011)
                      Compiled in at build time — see DEPLOYMENT.md section 4.
  MTMS_SKIP_TESTS=1   re-package without running the suite
USAGE
    exit 1
    ;;
esac
