import { expect, test, type Page } from '@playwright/test';

/**
 * The journeys that only a browser can prove.
 *
 * Each test is named after the behaviour a user would notice, not the component it
 * touches — a failure here should tell you what broke for whom.
 */

const ADMIN = { email: 'parmahaj@mahajan.com', password: 'tracker' };
const VIEWER = { email: 'k.menon@mahajan.com', password: 'tracker' };

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Prod readiness' })).toBeVisible();
}

test.describe('signing in', () => {
  test('rejects an empty form with the message the design specifies', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Enter your email and password.');
  });

  test('rejects something that is not an email', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Work email').fill('not-an-email');
    await page.getByLabel('Password').fill('tracker');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('That does not look like an email address.');
  });

  test('says the same thing for a wrong password as for an unknown account', async ({ page }) => {
    // Two different messages would let anyone enumerate who has an account here.
    await page.goto('/login');
    await page.getByLabel('Work email').fill(ADMIN.email);
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const wrongPassword = await page.getByRole('alert').textContent();

    await page.getByLabel('Work email').fill('nobody@mahajan.com');
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText(wrongPassword ?? '');
  });

  test('sends an unauthenticated visitor to the sign-in screen', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/matrix');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('the matrix', () => {
  test.beforeEach(async ({ page }) => signIn(page, ADMIN));

  test('is a real grid, so a screen reader can say where it is', async ({ page }) => {
    await page.goto('/matrix');
    const grid = page.getByRole('grid');
    await expect(grid).toBeVisible();

    // 14 seeded columns plus module, ready and target.
    await expect(grid).toHaveAttribute('aria-colcount', '17');
    expect(Number(await grid.getAttribute('aria-rowcount'))).toBeGreaterThan(18);
  });

  test('advancing a cell stamps it and moves the dashboard', async ({ page }) => {
    await page.goto('/');
    const before = Number(
      await page.getByRole('button', { name: /Blank cells/ }).locator('span').first().textContent(),
    );

    await page.goto('/matrix');
    const blank = page.getByRole('button', { name: /Not filled$/ }).first();
    await blank.click();

    // The optimistic paint should land immediately, and survive the server's reply.
    await expect(page.getByRole('button', { name: /P\. Mahajan/ }).first()).toBeVisible();

    await page.goto('/');
    const after = Number(
      await page.getByRole('button', { name: /Blank cells/ }).locator('span').first().textContent(),
    );
    expect(after).toBe(before - 1);
  });

  test('a roll-up cell opens its subactivities rather than editing', async ({ page }) => {
    await page.goto('/matrix');
    const rolled = page.getByRole('button', { name: /rolled up from \d+ subactivities/ }).first();
    await rolled.click();

    await expect(page.getByText('↳', { exact: false }).first()).toBeVisible();
  });

  test('filters survive a reload, because they live in the URL', async ({ page }) => {
    await page.goto('/matrix');
    await page.getByRole('button', { name: 'SBC', exact: true }).click();
    await expect(page).toHaveURL(/node=SBC/);

    await page.reload();
    await expect(page.getByRole('button', { name: 'SBC', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

test.describe('permissions are real, not decoration', () => {
  test('a viewer sees the controls, disabled, and is told why', async ({ page }) => {
    await signIn(page, VIEWER);
    await page.goto('/matrix');

    await expect(page.getByText(/cells are read-only for you/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Not filled$/ }).first()).toBeDisabled();
  });

  test('the API refuses a viewer independently of the UI', async ({ page, request }) => {
    await signIn(page, VIEWER);

    // Straight at the endpoint, bypassing every disabled control.
    const snapshot = await request.get('/api/v1/snapshot');
    const body = await snapshot.json();
    const target = body.data.modules.find(
      (module: { subactivities: unknown[] }) => module.subactivities.length === 0,
    );

    const refused = await request.patch('/api/v1/cells', {
      data: { module_id: target.id, subactivity_id: null, column_key: 'oh' },
    });
    expect(refused.status()).toBe(403);
  });
});

test.describe('the FNI gate', () => {
  test.beforeEach(async ({ page }) => signIn(page, ADMIN));

  test('will not close a module that is not ready, and says what is blocking', async ({ page }) => {
    await page.goto('/matrix');
    await page.getByRole('link', { name: '127_NEW_SUBNET_CREATION_MEDIA_SBC' }).click();

    const signOff = page.getByRole('button', { name: 'Mark FNI done' });
    await expect(signOff).toBeDisabled();
    await expect(page.getByText(/^Blocked —/)).toBeVisible();
  });
});

test.describe('drift', () => {
  test.beforeEach(async ({ page }) => signIn(page, ADMIN));

  test('shows the seeded failures and blocks promotion', async ({ page }) => {
    await page.goto('/drift');

    await expect(page.getByText('Prod behind')).toBeVisible();
    await expect(page.getByText('Never verified')).toBeVisible();
    await expect(page.getByRole('button', { name: /blocked by \d+ gates?/i })).toBeDisabled();
  });
});
