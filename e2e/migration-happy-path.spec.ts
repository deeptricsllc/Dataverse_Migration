import { expect, test, type Page } from '@playwright/test';

/**
 * Owner acceptance journey in DEMO MODE:
 * login → environments → source/target → verify → analyze → schema diff → select tables →
 * dependencies → mapping → plan review → execute → monitor → validate → report → reopen history.
 */
test('demo happy path: plan, migrate and validate', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  // 1. Login
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();
  await expect(page.getByText('DEMO MODE').first()).toBeVisible();

  // 2. Environments (auto-discovered on first visit)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Environments' }).click();
  const devCard = page.getByTestId('env-card-DeepTrics Development');
  const qaCard = page.getByTestId('env-card-DeepTrics QA');
  await expect(devCard).toBeVisible();
  await expect(qaCard).toBeVisible();
  await expect(page.getByTestId('env-card-DeepTrics UAT')).toBeVisible();

  await devCard.getByRole('button', { name: 'Set as source' }).click();
  await expect(devCard.getByRole('button', { name: 'Source', exact: true })).toBeVisible();
  await qaCard.getByRole('button', { name: 'Set as target' }).click();
  await expect(qaCard.getByRole('button', { name: 'Target', exact: true })).toBeVisible();
  await expect(page.getByTestId('workspace-source')).toContainText('DeepTrics Development');
  await expect(page.getByTestId('workspace-target')).toContainText('DeepTrics QA');

  // Failing environment shows a clear error.
  const prodCard = page.getByTestId('env-card-DeepTrics Production');
  await prodCard.getByRole('button', { name: 'Test connection' }).click();
  await expect(prodCard.getByText(/not a member of the organization/)).toBeVisible();

  await page.getByRole('button', { name: 'Verify both connections' }).click();
  await expect(devCard.getByText('Connected', { exact: true })).toBeVisible();
  await expect(qaCard.getByText('Connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Analyze' }).click();

  // 3. Analyze & schema diff
  await expect(page).toHaveURL(/\/compare/);
  await page.getByRole('button', { name: 'Analyze now' }).click();
  await expect(page.getByRole('button', { name: /Tables compared/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /Potentially incompatible/ })).toBeVisible();
  await page.getByTestId('diff-row-account').click();
  await expect(page.getByText('dtx_tier', { exact: true })).toBeVisible();
  await expect(page.getByText('Choice values 7 do not exist in target')).toBeVisible();
  await page.getByTestId('diff-row-product').click();
  await expect(page.getByText('String cannot be converted to Integer')).toBeVisible();

  // 4. Select tables (dependencies are shown, not auto-selected)
  await page.getByRole('button', { name: 'Continue: Select tables' }).click();
  await expect(page.getByRole('heading', { name: 'Select tables to migrate' })).toBeVisible();
  await selectTable(page, 'account');
  await expect(page.getByTestId('dependency-hint-account')).toContainText('Contact');
  await expect(page.getByTestId('dependency-hint-account')).toContainText('Region');
  for (const t of ['contact', 'dtx_region', 'dtx_office', 'dtx_applicationconfig', 'product']) await selectTable(page, t);
  await expect(page.getByTestId('dependency-hint-account')).toHaveCount(0);
  await page.getByRole('button', { name: /Generate migration plan/ }).click();

  // 5. Dependencies
  await expect(page.getByTestId('migration-order')).toBeVisible({ timeout: 60_000 });
  const order = await page.getByTestId('migration-order').innerText();
  expect(order.indexOf('Region')).toBeLessThan(order.indexOf('Office'));
  expect(order.indexOf('Account')).toBeLessThan(order.indexOf('Contact'));
  await expect(page.getByText(/Cycle \d: account ↔ contact/)).toBeVisible();

  // 6. Field mapping
  await page.getByRole('button', { name: 'Continue: Map fields' }).click();
  await page.getByRole('button', { name: /^Account/ }).click();
  await expect(page.getByTestId('mapping-accountnumber')).toBeVisible();
  await expect(page.getByTestId('mapping-dtx_tier')).toContainText('Unmapped');
  await expect(page.getByTestId('mapping-ownerid')).toContainText('Ignored');

  // 7. Review & execute
  await page.getByRole('button', { name: 'Continue: Review plan' }).click();
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  await expect(page.getByTestId('issue-WARNING').first()).toBeVisible();
  await page.getByRole('button', { name: 'Execute migration' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm migration execution' });
  await expect(dialog.getByText('DeepTrics Development').first()).toBeVisible();
  await expect(dialog.getByText('DeepTrics QA').first()).toBeVisible();
  const runButton = dialog.getByRole('button', { name: 'Write data to DeepTrics QA' });
  await expect(runButton).toBeDisabled();
  await dialog.getByTestId('ack-warnings').check();
  await dialog.getByLabel(/Type the target environment name/).fill('DeepTrics QA');
  await runButton.click();

  // 8. Monitor
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByTestId('run-entity-account')).toBeVisible();
  await expect(page.getByText('Completed with errors').first()).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('overall-percent')).toContainText('%');
  await page.getByRole('tab', { name: /Errors/ }).click();
  await expect(page.getByTestId('run-error-row').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Rollback preview' }).click();
  await expect(page.getByText('Rollback execution: NOT YET SUPPORTED')).toBeVisible();

  // 9. Validate & report
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page).toHaveURL(/\/validation\//);
  await expect(page.getByRole('heading', { name: 'Results by table' })).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('validation-entity-account').click();
  await expect(page.getByText('Record existence')).toBeVisible();
  await page.getByRole('button', { name: 'Inspect differences for Account' }).click();
  await expect(page.getByTestId('difference-row').first()).toBeVisible();

  // 10. Reopen: history persists
  const reportUrl = page.url();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Validation report' })).toBeVisible();
  await page.goto('/runs');
  await expect(page.getByTestId('run-row')).toHaveCount(1);
  await page.getByRole('tab', { name: /Validation runs/ }).click();
  await expect(page.getByTestId('validation-row')).toHaveCount(1);
  await page.goto(reportUrl);
  await expect(page.getByTestId('validation-entity-account')).toBeVisible();

  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});

async function selectTable(page: Page, logicalName: string) {
  const row = page.getByTestId(`table-row-${logicalName}`);
  await row.getByRole('checkbox').check();
  await expect(row.getByRole('checkbox')).toBeChecked();
}
