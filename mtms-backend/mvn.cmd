@echo off
REM ---------------------------------------------------------------------------
REM Runs Maven with the toolchain this project actually needs.
REM
REM Neither is on PATH: `java` resolves to a JDK 8 from 2022 and `mvn` to Maven
REM 3.0.5 from 2013, and Spring Boot 3 builds with neither. Rather than change the
REM machine's PATH — which other Nokia tooling here depends on — this script points
REM at the newer pair for the length of one command.
REM
REM Offline flags live in .mvn\maven.config and apply automatically.
REM
REM   mvn.cmd test
REM   mvn.cmd spring-boot:run
REM ---------------------------------------------------------------------------
setlocal

if not defined MTMS_JAVA_HOME set "MTMS_JAVA_HOME=%USERPROFILE%\.jdks\ms-21.0.10"
if not defined MTMS_MAVEN_HOME set "MTMS_MAVEN_HOME=C:\tmp\radius-tools\maven\apache-maven-3.9.9"

if not exist "%MTMS_JAVA_HOME%\bin\javac.exe" (
  echo [mtms] No JDK 21 at %MTMS_JAVA_HOME%
  echo [mtms] Set MTMS_JAVA_HOME to a JDK 21 and try again.
  exit /b 1
)
if not exist "%MTMS_MAVEN_HOME%\bin\mvn.cmd" (
  echo [mtms] No Maven at %MTMS_MAVEN_HOME%
  echo [mtms] Set MTMS_MAVEN_HOME to Maven 3.6.3+ and try again.
  exit /b 1
)

set "JAVA_HOME=%MTMS_JAVA_HOME%"
set "PATH=%JAVA_HOME%\bin;%MTMS_MAVEN_HOME%\bin;%PATH%"

call "%MTMS_MAVEN_HOME%\bin\mvn.cmd" %*
exit /b %ERRORLEVEL%
