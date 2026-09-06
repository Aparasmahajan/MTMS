import { expect, test, type Page } from '@playwright/test';

/**
 * The two behaviours this repository exists to add: edits that survive a reload, and edits
 * that appear in another tab without one.
 *
 * Both are browser behaviours. Neither can be proved by a unit test, because both are about
 * what `localStorage` and `BroadcastChannel` actually do across page loads and across tabs —
 * so these open real tabs of the real built site.
 *
 * Run `npm run build` first; these test the artefact in `demo/`, not a dev server.
 */

/**
 * A RITM cell that this row owns.
 *
 * Two exclusions, both load-bearing. RITM is a two-status cycle, so one click has an
 * unambiguous result. The `rolled up` filter skips modules with subactivities: their row is
 * derived, and clicking it opens the subactivities rather than advancing anything. Those
 * buttons are *not* disabled — they are still clickable, just for a different purpose — so
 * filtering on `:disabled` does not catch them, and a suite that used one would be asserting
 * that a navigation control fails to edit.
 */
const EDITABLE_RITM = 'button[aria-label^="RITM raised — "]:not([aria-label*="rolled up"])';

/** The storage key `lib/demo/persistence.ts` writes. */
const STORAGE_KEY = 'mtms.static.snapshot.v1';

async function openMatrix(page: Page) {
  await page.goto('/matrix');
  await expect(page.getByRole('heading', { name: 'Module matrix' })).toBeVisible();
}

/**
 * The status of the first editable RITM cell.
 *
 * Just the status, not the whole label: once a cell has been touched the label gains
 * "· P. Mahajan, just now", and that stamp is relative, so comparing full labels would make
 * these tests start failing a minute after they were written.
 */
async function ritmStatus(page: Page): Promise<string> {
  const cell = page.locator(EDITABLE_RITM).first();
  await expect(cell).toBeVisible();
  const label = (await cell.getAttribute('aria-label')) ?? '';
  return label.split(' — ')[1]?.split(' · ')[0] ?? '';
}

async function clickRitm(page: Page) {
  await page.locator(EDITABLE_RITM).first().click();
}

test.beforeEach(async ({ context }) => {
  // Each test starts from the seed. Without this the previous test's edits are still in
  // localStorage and the assertions drift as the file runs.
  const page = await context.newPage();
  await page.goto('/matrix');
  await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY);
  await page.close();
});

test('an edit survives a reload', async ({ page }) => {
  await openMatrix(page);

  const before = await ritmStatus(page);
  await clickRitm(page);

  // Poll rather than sleep: the optimistic update is immediate, but a fixed timeout would
  // pass on a slow machine for the wrong reason.
  await expect.poll(() => ritmStatus(page)).not.toBe(before);
  const afterClick = await ritmStatus(page);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Module matrix' })).toBeVisible();

  expect(await ritmStatus(page)).toBe(afterClick);
  expect(afterClick).not.toBe(before);
});

test('an edit in one tab appears in another without reloading it', async ({ context }) => {
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  await openMatrix(tabA);
  await openMatrix(tabB);

  const before = await ritmStatus(tabB);
  await clickRitm(tabA);

  // tabB is never touched, never reloaded and never navigated. If this passes, the
  // BroadcastChannel message arrived and the provider re-rendered from it.
  await expect.poll(() => ritmStatus(tabB), { timeout: 5_000 }).not.toBe(before);

  expect(await ritmStatus(tabB)).toBe(await ritmStatus(tabA));
});

test('a tab opened later starts from the saved state, not the seed', async ({ context }) => {
  const tabA = await context.newPage();
  await openMatrix(tabA);

  const seeded = await ritmStatus(tabA);
  await clickRitm(tabA);
  await expect.poll(() => ritmStatus(tabA)).not.toBe(seeded);
  const edited = await ritmStatus(tabA);

  const tabB = await context.newPage();
  await openMatrix(tabB);

  // The prerendered HTML carries the seed, so this only passes if the runtime prefers what
  // was saved over what was baked in.
  expect(await ritmStatus(tabB)).toBe(edited);
  expect(edited).not.toBe(seeded);
});

test('what is stored is a real snapshot, not just what is on screen', async ({ page }) => {
  await openMatrix(page);
  await clickRitm(page);
  await expect.poll(() => ritmStatus(page)).toBe('Not raised');

  const stored = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
  expect(stored).toBeTruthy();

  // Reading it back matters: the screen could look right while the stored copy was stale or
  // truncated, and the next reload would silently lose the edit.
  const snapshot = JSON.parse(stored as string);
  expect(snapshot.modules.length).toBeGreaterThan(0);
  expect(snapshot.audit[0].label).toBe('RITM');
});
