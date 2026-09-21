#!/usr/bin/env bash
#
# MTMS — put both processes under pm2, on the server.
#
# Run it ON THE SERVER, as the user that owns ~/mtms:
#
#   ssh devteamjava@HRMSPRODUCTION 'bash ~/mtms/install-pm2.sh'
#
# It is idempotent — run it again after a redeploy and it reloads both apps.
#
# What it replaces, and why: both programs were started with `nohup ... &` from an interactive
# SSH session. nohup blocks SIGHUP and nothing else, so nothing watched either process and
# nothing restarted it. nginx proxies to 6010 only, so the moment node went, the site answered
# 502 until somebody logged in and started it by hand.

set -euo pipefail

RUN_HOME="${HOME}"
API_DIR="${MTMS_API_DIR:-$RUN_HOME/mtms/backend}"
WEB_DIR="${MTMS_WEB_DIR:-$RUN_HOME/mtms/frontend/dist-frontend}"
ENV_FILE="${MTMS_ENV_FILE:-mtms.env}"
ECOSYSTEM="${MTMS_ECOSYSTEM:-$RUN_HOME/mtms/ecosystem.config.js}"
API_PORT="${MTMS_API_PORT:-6011}"
WEB_PORT="${MTMS_WEB_PORT:-6010}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1merror: %s\033[0m\n' "$*" >&2; exit 1; }

# --- Check before starting ---------------------------------------------------
#
# Every one of these produces a confusing failure rather than a loud one if it is wrong, so
# they are worth a second here rather than ten minutes in `pm2 logs`.

command -v pm2  > /dev/null || die "pm2 is not installed. sudo npm install -g pm2"
command -v java > /dev/null || die "no java on PATH"
command -v node > /dev/null || die "no node on PATH"

[ -f "$ECOSYSTEM" ]                              || die "no ecosystem.config.js at $ECOSYSTEM — scp it up first"
[ -f "$API_DIR/mtms-api-1.0.0-SNAPSHOT.jar" ]    || die "no JAR in $API_DIR"
[ -f "$API_DIR/$ENV_FILE" ]                      || die "no $ENV_FILE in $API_DIR"
[ -d "$WEB_DIR" ]                                || die "no $WEB_DIR — unpack mtms-frontend.tar.gz first"
[ -f "$WEB_DIR/server.js" ]                      || die "no server.js in $WEB_DIR — the tarball did not unpack correctly"

# ecosystem.config.js parses this file as KEY=value and nothing else. `set -a && . ./mtms.env`
# was a shell and tolerated more; a value containing $OTHER worked there and becomes literal
# text here. Say so now rather than letting the API start with a broken DATABASE_URL.
if grep -qE '[$]' "$API_DIR/$ENV_FILE"; then
  printf '\n  warning: %s contains a $ — pm2 does not expand it the way `. mtms.env` did.\n' "$ENV_FILE"
  printf '           Check the value is meant to be literal:\n\n'
  grep -nE '[$]' "$API_DIR/$ENV_FILE" | sed 's/^/           /'
  printf '\n'
fi

say "Starting under pm2"
printf '  api   %s\n'   "$API_DIR"
printf '  web   %s\n'   "$WEB_DIR"
printf '  env   %s\n\n' "$API_DIR/$ENV_FILE"

# --- Hand over from the nohup processes --------------------------------------
#
# They still hold 6010 and 6011. Start pm2 without this and both apps fail on "Address already
# in use", which lands in pm2's log looking exactly like a startup fault.

say "Stopping whatever nohup left running"
pkill -u "$USER" -f mtms-api-1.0.0-SNAPSHOT.jar || true
pkill -u "$USER" -f "node.*server.js" || true
sleep 3

say "Starting"
pm2 start "$ECOSYSTEM" --update-env

# --- Survive a reboot --------------------------------------------------------
#
# Both are required and neither is optional. `pm2 startup` prints a sudo command that installs
# a systemd unit for the pm2 daemon itself; `pm2 save` writes the process list that unit
# replays. Skip either and pm2 comes back empty after a reboot — which looks identical to the
# problem this script exists to fix.

say "Making it survive a reboot"
pm2 save
if ! systemctl list-unit-files 2>/dev/null | grep -q "pm2-$USER"; then
  printf '\n  pm2 is NOT yet set to start on boot. Run the command pm2 prints below, then\n'
  printf '  re-run `pm2 save`:\n\n'
  { pm2 startup || true; } | tail -3 | sed 's/^/  /'
  printf '\n'
else
  printf '  pm2-%s.service is installed — pm2 will come back on boot.\n' "$USER"
fi

# Flyway runs on the API's first start and the JVM is not quick.
say "Waiting for the API"
sleep 15

api=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/actuator/health" || echo 000)
web=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$WEB_PORT/login" || echo 000)
printf '\n  api  %s\n  web  %s\n\n' "$api" "$web"

pm2 list

if [ "$api" != "200" ] || [ "$web" != "200" ]; then
  die "not healthy — read: pm2 logs mtms-api --lines 50"
fi

say "Both up, and both will now restart on crash"
cat <<'NEXT'

  pm2 list                      is it up, and how many times has it restarted
  pm2 logs mtms-web             follow the logs (these do NOT truncate on restart)
  pm2 restart mtms-api
  pm2 monit                     live CPU and memory, which is how you catch an OOM loop

A climbing restart count in `pm2 list` is not "pm2 working". It means something is still
killing the process and pm2 is hiding it. Read the logs when you see it.

NEXT
