import { expect, test, type Page } from '@playwright/test';
import { STORAGE_KEY, WORKSPACE_KEY } from '../lib/demo/persistence';

/**
 * The controls the last port added, clicked in the built site.
 *
 * Each one used to end in "The demo has no handler for …" — or, for the sub-module link, in a
 * 404 — and every one of them typechecked and passed the unit suite while doing so. The only
 * place that failure shows is a real click on the exported page, so that is what these do.
 *
 * Run `npm run build` first; like the persistence spec, these test the artefact in `demo/`.
 */

test.beforeEach(async ({ context }) => {
  const page = await context.newPage();
  await page.goto('/matrix');
  await page.evaluate(
    (keys) => keys.forEach((key) => window.localStorage.removeItem(key)),
    [STORAGE_KEY, WORKSPACE_KEY],
  );
  await page.close();
});

/** Any refusal the demo raises lands in the error banner; none of these should produce one. */
async function expectNoDemoError(page: Page) {
  await expect(page.getByText(/The demo has no handler/)).toHaveCount(0);
}

/** The seeded sub-module with a checklist and a discussion — reached the way a user would. */
async function openSeededChecklist(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await page.getByText('Testing done by QA is blocked').first().click();
  await expect(page).toHaveURL(/\/sub-modules\/[^/]+\/?$/);
  await expect(page.getByRole('heading', { name: 'Checklist' })).toBeVisible();
}

test('a sub-module link on the matrix opens its page', async ({ page }) => {
  await page.goto('/matrix');
  await expect(page.getByRole('heading', { name: 'SubModule matrix' })).toBeVisible();

  // A row of the matrix, not the header's "Sub-module" tab, which links to the same route.
  const link = page
    .locator('a[href^="/sub-modules/"]')
    .filter({ hasNotText: /^\s*Sub-module\s*$/ })
    .first();
  const name = (await link.textContent())?.trim() ?? '';
  await link.click();

  await expect(page).toHaveURL(/\/sub-modules\/[^/]+\/?$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
});

test('the Sub-module tab opens a page that exists', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sub-module', exact: true }).click();
  await expect(page).toHaveURL(/\/sub-modules\/[^/]+\/?$/);
  await expect(page.locator('h1')).toBeVisible();
});

test('ticking a checklist step records it', async ({ page }) => {
  // An admin ticking a step reserved for another role is asked why — the override prompt.
  page.on('dialog', (dialog) => void dialog.accept('Ticked during the demo'));
  await openSeededChecklist(page);

  // The blocked step. The seeded checklist runs in strict order, so the step after it is
  // correctly locked; ticking the blocked one — an admin override, answered by the prompt
  // handler above — is the one tick the seed allows.
  const step = page.locator('button[aria-label$=" — blocked"]').first();
  const label = (await step.getAttribute('aria-label')) ?? '';
  const stepName = label.replace(/ — blocked$/, '');
  await step.click();

  await expect(page.getByRole('button', { name: `${stepName} — done`, exact: true }).first()).toBeVisible();
  await expectNoDemoError(page);

  // And it is a stored edit, not a repaint: it survives a reload.
  await page.reload();
  await expect(page.getByRole('button', { name: `${stepName} — done`, exact: true }).first()).toBeVisible();
});

test('raising a discussion topic posts it', async ({ page }) => {
  await openSeededChecklist(page);

  await page.getByLabel('New topic').fill('Rollback plan for the window');
  await page.getByLabel('Opening comment').fill('Who signs off the rollback if prod fails?');
  await page.getByRole('button', { name: 'Raise it' }).click();

  // Once as the topic and once in the history beside it; the topic is the button.
  const topic = page.getByRole('button', { name: /^Rollback plan for the window/ });
  await expect(topic).toBeVisible();
  // A new topic is listed collapsed; its opening comment is inside.
  await topic.click();
  await expect(page.getByText('Who signs off the rollback if prod fails?')).toBeVisible();
  await expectNoDemoError(page);
});

test('adding a column gives it the name that was typed', async ({ page }) => {
  await page.goto('/configure');
  await page.getByLabel('New column name').fill('Smoke Test');
  await page.getByRole('button', { name: 'Add column' }).click();

  await expect(page.getByText('Smoke Test', { exact: true }).first()).toBeVisible();
  await expectNoDemoError(page);

  // On the matrix too, headed with what was typed rather than an empty x_ key.
  await page.goto('/matrix');
  await expect(page.getByText('SMOKE TEST', { exact: true }).first()).toBeVisible();
});

test('marking the inbox read clears the badge', async ({ page }) => {
  await page.goto('/');
  const inbox = page.getByRole('button', { name: /^Inbox/ });
  await expect(inbox).toHaveAccessibleName(/unread/);
  await inbox.click();
  await page.getByRole('button', { name: /mark all read/i }).click();
  await expect(page.getByRole('button', { name: 'Inbox', exact: true })).toBeVisible();
});
