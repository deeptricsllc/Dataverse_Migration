import { expect, test } from '@playwright/test';

const DIR =
  'C:/Users/srini/AppData/Local/Temp/claude/c--Users-srini-OneDrive-Documents-Dataverse-Migration/9c08dbb9-61eb-4556-8466-3ba3e20b8379/scratchpad/phase3';

test('phase 3 buyer walk', async ({ page }) => {
  test.setTimeout(900_000);
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));

  await page.goto('/login');
  await page.screenshot({ path: `${DIR}/00-login.png`, fullPage: true });
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible({ timeout: 60_000 });

  await page.goto('/projects');
  await expect(
    page.getByRole('link', { name: 'Customer Migration — Data Quality Issues', exact: true }),
  ).toBeVisible({ timeout: 600_000 });

  await page.goto('/runs');
  await page.waitForTimeout(3000);
  await page.getByRole('row').filter({ hasText: 'Legacy customers' }).first().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${DIR}/01-run.png`, fullPage: true });
  await page.getByRole('link', { name: /Open the latest validation report/ }).click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${DIR}/02-validation.png`, fullPage: true });

  await page.goto('/environments');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${DIR}/03-connections.png`, fullPage: true });

  console.log('CONSOLE ERRORS: ' + JSON.stringify(problems));
});
