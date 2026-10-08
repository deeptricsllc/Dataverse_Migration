import { expect, test, type Page } from '@playwright/test';

/**
 * What the projects page says while its worked examples are being built, and when they were not.
 *
 * The failure this covers was seen on deployed QA: a workspace with no examples, reporting that it was
 * being prepared, for ever. Nothing was preparing it. The build had given up, recorded nothing, and the
 * screen had only "not ready" to go on — which it read as "still going".
 *
 * The happy path is driven for real. The failed state is driven against the exact payload the server
 * emits for it, because a simulated Dataverse does not refuse discovery and there is no honest way to
 * make a deployed demo fail that way. What the server emits in that state is covered against the real
 * engine in `tests/integration/demo-initialization.test.ts`; what is covered here is the screen.
 */

const signIn = async (page: Page) => {
  await page.goto('/login');
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/auth/demo-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return r.status;
  });
  expect(status).toBe(200);
};

test('a workspace being prepared says so, and then stops saying it', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (msg) => msg.type() === 'error' && problems.push(`console — ${msg.text()}`));
  page.on('pageerror', (err) => problems.push(`page error — ${err.message}`));

  await signIn(page);
  await page.goto('/projects');

  /*
   * The preparing state is real and brief, so it is not required to be caught — only required not to be
   * wrong when it is. What must hold is that the workspace arrives and never claims to have failed.
   */
  const preparing = page.getByTestId('demo-building');
  if (await preparing.isVisible().catch(() => false)) {
    await expect(preparing).toContainText('Preparing demo workspace');
    await expect(preparing).toContainText('Demo data is being prepared');
  }

  await expect(page.getByText('Customer Migration — Successful')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText('Customer Migration — Data Quality Issues')).toBeVisible();

  // And once it is there, neither callout remains.
  await expect(page.getByTestId('demo-building')).toHaveCount(0);
  await expect(page.getByTestId('demo-setup-failed')).toHaveCount(0);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('a workspace that did not finish setting up says that, and offers a way out', async ({ page }) => {
  await signIn(page);

  // The payload the server sends for a workspace whose setup failed.
  await page.route('**/api/demo/status*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'FAILED',
        ready: false,
        building: false,
        detail: 'The simulated environments are not all present: DeepTrics QA missing.',
        attempts: 1,
        canRetry: true,
      }),
    }),
  );

  let retried = 0;
  await page.route('**/api/demo/retry-setup', (route) => {
    retried++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'READY',
        ready: true,
        building: false,
        detail: null,
        attempts: 2,
        canRetry: false,
      }),
    });
  });

  await page.goto('/projects');

  const failed = page.getByTestId('demo-setup-failed');
  await expect(failed).toBeVisible();
  await expect(failed).toContainText('Demo workspace unavailable');
  await expect(failed).toContainText('Setup did not complete');
  // The reason the server recorded, shown rather than summarised away.
  await expect(page.getByTestId('demo-setup-detail')).toContainText('DeepTrics QA missing');
  // It must not also be claiming to be preparing anything.
  await expect(page.getByTestId('demo-building')).toHaveCount(0);

  await page.getByTestId('retry-demo-setup').click();
  await expect.poll(() => retried).toBe(1);
  // Once setup reports ready, the callout goes.
  await expect(page.getByTestId('demo-setup-failed')).toHaveCount(0);
});
