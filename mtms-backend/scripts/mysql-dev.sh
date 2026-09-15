#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# A throwaway MySQL for checking the schema and the JDBC layer.
#
# Docker is not an option on this machine: the daemon runs, but pulling an image is
# refused with "Membership in the [nokiasam] organization is required", enforced by
# registry.json. So this downloads the standalone server zip instead, which needs no
# installation and no administrator rights.
#
#   ./scripts/mysql-dev.sh up      # download if needed, initialise, start on port 13306
#   ./scripts/mysql-dev.sh schema  # drop and re-apply V1__initial_schema.sql
#   ./scripts/mysql-dev.sh cli     # a mysql prompt on the mtms database
#   ./scripts/mysql-dev.sh down    # stop the server
#   ./scripts/mysql-dev.sh clean   # stop it and delete everything it wrote
#
# Nothing here belongs in production. It exists so that a change to the schema can be
# proved to apply, rather than reviewed and hoped over — the mistake it caught first time
# was a foreign key InnoDB refuses on the base column of a STORED generated column, which
# no amount of reading would have found.
# ---------------------------------------------------------------------------
set -euo pipefail

VERSION="8.0.40"
PORT="${MTMS_MYSQL_PORT:-13306}"
ROOT="${MTMS_MYSQL_HOME:-$HOME/.mtms/mysql}"
DIST="$ROOT/mysql-$VERSION-winx64"
DATA="$ROOT/data"
LOG="$ROOT/mysqld.log"
SCHEMA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/main/resources/db/migration/V1__initial_schema.sql"

mysql_cli() { "$DIST/bin/mysql.exe" -u root -h 127.0.0.1 -P "$PORT" "$@"; }

download() {
  if [ -x "$DIST/bin/mysqld.exe" ]; then return; fi
  mkdir -p "$ROOT"
  echo "[mysql] downloading $VERSION (~230 MB, once)"
  curl -sSL --max-time 1800 -o "$ROOT/mysql.zip" \
    "https://cdn.mysql.com//archives/mysql-8.0/mysql-$VERSION-winx64.zip"
  unzip -q -o "$ROOT/mysql.zip" -d "$ROOT"
  rm -f "$ROOT/mysql.zip"
}

up() {
  download
  if mysql_cli -e "SELECT 1" >/dev/null 2>&1; then
    echo "[mysql] already up on $PORT"
    return
  fi
  if [ ! -d "$DATA" ]; then
    echo "[mysql] initialising a fresh data directory"
    "$DIST/bin/mysqld.exe" --initialize-insecure --basedir="$DIST" --datadir="$DATA"
  fi
  echo "[mysql] starting on $PORT"
  nohup "$DIST/bin/mysqld.exe" --basedir="$DIST" --datadir="$DATA" \
    --port="$PORT" --console > "$LOG" 2>&1 &
  for _ in $(seq 1 20); do
    if mysql_cli -e "SELECT 1" >/dev/null 2>&1; then echo "[mysql] ready"; return; fi
    sleep 3
  done
  echo "[mysql] did not come up — see $LOG" >&2
  exit 1
}

case "${1:-up}" in
  up) up ;;
  schema)
    up
    mysql_cli -e "DROP DATABASE IF EXISTS mtms; CREATE DATABASE mtms CHARACTER SET utf8mb4;"
    mysql_cli mtms < "$SCHEMA"
    echo "[mysql] applied — $(mysql_cli -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='mtms';") tables"
    ;;
  cli) mysql_cli mtms ;;
  down)
    mysql_cli -e "SHUTDOWN" 2>/dev/null || true
    echo "[mysql] stopped"
    ;;
  clean)
    mysql_cli -e "SHUTDOWN" 2>/dev/null || true
    rm -rf "$DATA" "$LOG"
    echo "[mysql] stopped, data removed. The unpacked server stays in $DIST"
    ;;
  *) echo "usage: $0 {up|schema|cli|down|clean}" >&2; exit 2 ;;
esac
