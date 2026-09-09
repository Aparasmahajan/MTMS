#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Runs Maven with the toolchain this project actually needs.
#
# Neither is on PATH: `java` resolves to a JDK 8 from 2022 and `mvn` to Maven 3.0.5
# from 2013, and Spring Boot 3 builds with neither. Rather than change the machine's
# PATH — which other Nokia tooling here depends on — this script points at the newer
# pair for the length of one command.
#
# Offline flags live in .mvn/maven.config and apply automatically.
#
#   ./mvn.sh test
#   ./mvn.sh spring-boot:run
# ---------------------------------------------------------------------------
set -euo pipefail

MTMS_JAVA_HOME="${MTMS_JAVA_HOME:-$HOME/.jdks/ms-21.0.10}"
MTMS_MAVEN_HOME="${MTMS_MAVEN_HOME:-/c/tmp/radius-tools/maven/apache-maven-3.9.9}"

if [ ! -x "$MTMS_JAVA_HOME/bin/javac" ] && [ ! -f "$MTMS_JAVA_HOME/bin/javac.exe" ]; then
  echo "[mtms] No JDK 21 at $MTMS_JAVA_HOME" >&2
  echo "[mtms] Set MTMS_JAVA_HOME to a JDK 21 and try again." >&2
  exit 1
fi
if [ ! -f "$MTMS_MAVEN_HOME/bin/mvn" ]; then
  echo "[mtms] No Maven at $MTMS_MAVEN_HOME" >&2
  echo "[mtms] Set MTMS_MAVEN_HOME to Maven 3.6.3+ and try again." >&2
  exit 1
fi

export JAVA_HOME="$MTMS_JAVA_HOME"
export PATH="$JAVA_HOME/bin:$MTMS_MAVEN_HOME/bin:$PATH"

cd "$(dirname "$0")"
exec mvn "$@"
