// MTMS under pm2.
//
//   pm2 start ecosystem.config.js
//   pm2 startup && pm2 save      <- without BOTH of these, nothing comes back after a reboot
//
// Why this exists: both programs were started with `nohup ... &` from an interactive SSH
// session. nohup blocks SIGHUP and nothing else, so nothing was watching either process and
// nothing restarted them. The symptom was a 502 from nginx a day or two after a release —
// nginx proxies to 6010 only, so the moment the Next.js process goes, the site is down until
// somebody SSHes in and starts it by hand.
//
// Both apps are here, not just the web one. The API is exactly as unsupervised as the web app
// was; it had simply not been hit yet.

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME;
const API_DIR = process.env.MTMS_API_DIR || path.join(HOME, 'mtms', 'backend');
const WEB_DIR = process.env.MTMS_WEB_DIR || path.join(HOME, 'mtms', 'frontend', 'dist-frontend');
const ENV_FILE = process.env.MTMS_ENV_FILE || 'mtms.env';
const JAR = 'mtms-api-1.0.0-SNAPSHOT.jar';

// The API's environment lives in a file that `set -a && . ./mtms.env` used to source. pm2 has
// no equivalent, so parse it here — deliberately as KEY=value and nothing else. It is NOT a
// shell: a value containing $OTHER stays the literal text, which is the safe direction to be
// wrong in. DATABASE_URL contains & and needs no quoting here for that reason.
function readEnvFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error('no ' + file + ' — the API cannot start without it');
  }
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();                       // also strips a stray CR
    if (!line || line.startsWith('#')) continue;
    const m = line.replace(/^export +/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const apiEnv = readEnvFile(path.join(API_DIR, ENV_FILE));

// -Xmx belongs in mtms.env as JAVA_OPTS. On a shared box an unbounded JVM heap is the other
// way this process disappears with nothing in its own log: the kernel picks the largest thing
// on the machine, and that is always the JVM.
const javaArgs = (apiEnv.JAVA_OPTS ? apiEnv.JAVA_OPTS.split(' ').filter(Boolean) : [])
  .concat(['-jar', path.join(API_DIR, JAR)]);

module.exports = {
  apps: [
    {
      name: 'mtms-api',
      cwd: API_DIR,
      script: 'java',
      args: javaArgs,
      interpreter: 'none',        // java is not a node script; without this pm2 tries to run it as one
      env: apiEnv,

      autorestart: true,
      restart_delay: 10000,

      // The pm2 equivalent of systemd's StartLimitBurst: do not restart-loop forever on a
      // fault that will never fix itself — a wrong DATABASE_URL, a short JWT secret, a schema
      // that does not match. An app that stays up 20s counts as started; ten failures faster
      // than that and pm2 gives up, so `pm2 list` shows the failure instead of hiding it.
      min_uptime: '20s',
      max_restarts: 10,

      // The API finishes in-flight requests before exiting (server.shutdown: graceful,
      // timeout-per-shutdown-phase: 20s), so a restart during working hours does not fail
      // somebody's click. pm2 sends SIGINT by default and would not wait long enough.
      kill_signal: 'SIGTERM',
      kill_timeout: 30000,

      // No max_memory_restart here on purpose. pm2 measures RSS, and a healthy JVM's RSS is
      // much larger than its heap — a threshold that looks generous will restart a perfectly
      // well application every few hours. Cap the heap with -Xmx instead.

      time: true,                 // timestamps in the logs, which is what was missing when this broke
    },
    {
      name: 'mtms-web',
      cwd: WEB_DIR,               // not cosmetic: server.js resolves .next/static relative to its own
                                  // directory, and from anywhere else the page renders with no CSS
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.MTMS_WEB_PORT || '6010',
        HOSTNAME: '0.0.0.0',      // without this the standalone server binds to localhost only,
                                  // which looks like a firewall problem and is not one
      },

      autorestart: true,
      restart_delay: 5000,
      min_uptime: '10s',
      max_restarts: 10,

      kill_signal: 'SIGTERM',
      kill_timeout: 15000,

      // This one is worth having: if the web process is being OOM-killed, pm2 restarting it
      // into the same memory pressure is a loop, not a fix. Restarting it early and on purpose
      // is at least visible in `pm2 list` as a climbing restart count.
      max_memory_restart: '512M',

      time: true,
    },
  ],
};
