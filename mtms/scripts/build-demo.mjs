import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the static client demo.
 *
 * Two things have to be arranged before `next build` will produce a static export:
 *
 * 1. **The API routes have to go.** Every one of them reads the session cookie, which
 *    makes it dynamic, and `output: 'export'` refuses to build a dynamic route. They are
 *    moved aside for the build and put back afterwards — including if the build fails,
 *    which is why the restore is in a finally.
 * 2. **The store must be pristine.** The build bakes whatever the seed produces into the
 *    HTML, so it is pointed at a throwaway path rather than at `data/tracker.json`,
 *    where a developer's own clicking about would otherwise end up in a client demo.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDirectory = path.join(root, 'app', 'api');
const parkedDirectory = path.join(root, '.api-parked');
const exportDirectory = path.join(root, 'out');
const demoDirectory = path.join(root, 'demo');

/**
 * Windows holds directories open briefly — a sync client, an indexer, an editor that
 * still has the folder listed. Retrying clears it. `lib/server/store.ts` does the same
 * thing for the same reason; the alternative is a build that fails one time in five.
 */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

async function withRetry(action, attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts || !TRANSIENT.has(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    }
  }
}

async function restoreApiRoutes() {
  if (existsSync(parkedDirectory)) {
    await withRetry(() => rm(apiDirectory, { recursive: true, force: true }));
    await withRetry(() => rename(parkedDirectory, apiDirectory));
  }
}

async function main() {
  // A previous run may have been killed between the move and the restore.
  await restoreApiRoutes();

  const storePath = path.join(mkdtempSync(path.join(os.tmpdir(), 'mtms-demo-')), 'tracker.json');
  await withRetry(() => rm(exportDirectory, { recursive: true, force: true }));
  await withRetry(() => rm(demoDirectory, { recursive: true, force: true }));

  console.log('[demo] parking the API routes — a static export cannot carry them');
  await withRetry(() => rename(apiDirectory, parkedDirectory));

  try {
    const result = spawnSync('npx', ['next', 'build'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        NEXT_PUBLIC_DEMO: '1',
        TRACKER_STORE_PATH: storePath,
        JWT_SECRET: process.env.JWT_SECRET ?? 'demo-build-only-no-session-is-ever-issued',
      },
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  } finally {
    await restoreApiRoutes();
    console.log('[demo] API routes restored');
  }

  await withRetry(() => rename(exportDirectory, demoDirectory));
  console.log(`\n[demo] static site written to ${path.relative(process.cwd(), demoDirectory)}/`);
  console.log('[demo] serve it with any static host, e.g.  npx serve demo');
}

main().catch(async (error) => {
  await restoreApiRoutes();
  console.error('[demo] build failed', error);
  process.exit(1);
});
