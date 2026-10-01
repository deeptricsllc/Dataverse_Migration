import { expect, test } from '@playwright/test';

const DIR =
  'C:/Users/srini/AppData/Local/Temp/claude/c--Users-srini-OneDrive-Documents-Dataverse-Migration/9c08dbb9-61eb-4556-8466-3ba3e20b8379/scratchpad/walk';

test('walk the buyer journey', async ({ page }) => {
  test.setTimeout(600_000);
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  await page.goto('/login');
  await page.screenshot({ path: `${DIR}/00-login.png`, fullPage: true });
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${DIR}/01-dashboard.png`, fullPage: true });

  await page.goto('/projects');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${DIR}/02-projects.png`, fullPage: true });

  // Story A, end to end.
  await page.getByRole('link', { name: 'Customer Migration — Successful', exact: true }).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${DIR}/03-success-project.png`, fullPage: true });

  await page.goto('/runs');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${DIR}/04-runs.png`, fullPage: true });

  await page.getByRole('row').filter({ hasText: 'Regions, offices' }).first().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${DIR}/05-success-run.png`, fullPage: true });
  const report = page.getByRole('link', { name: /Open the latest validation report/ });
  if (await report.count()) {
    await report.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${DIR}/06-success-validation.png`, fullPage: true });
  }

  await page.goto('/validation');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${DIR}/07-validation-history.png`, fullPage: true });

  await page.goto('/settings');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${DIR}/08-settings.png`, fullPage: true });

  console.log('CONSOLE ERRORS: ' + JSON.stringify(consoleErrors));
});
