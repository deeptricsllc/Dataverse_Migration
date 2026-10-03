import { expect, test } from '@playwright/test';

/**
 * The analysis half of the platform, in the browser: a project whose kind is chosen from a dropdown,
 * an analysis of a real source, the results screen, the mapping workbook download, and a migration
 * project that starts from that analysis.
 */
test('analysis project: understand a source, then migrate from what it found', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  // 1. Sign in and reach Projects from the main navigation.
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

  // The connections have to be discovered before a project can name one.
  await page.goto('/environments');
  await expect(page.getByTestId('env-card-Legacy SQL Server (Demo)')).toBeVisible({ timeout: 60_000 });

  // 2. The dashboard's primary action lands on the form, not merely on the project list.
  await page.goto('/');
  await page.getByTestId('dashboard-new-project').click();
  await expect(page).toHaveURL(/\/projects\?new=1/);
  await expect(page.getByTestId('project-kind')).toBeVisible();

  // Choosing the kind decides what the form then asks for: an analysis project is never offered a
  // target.
  await page.getByTestId('project-kind').selectOption('ANALYSIS');
  await expect(page.getByText(/An analysis project has no target/)).toBeVisible();
  await page.getByTestId('project-name').fill('Understand the legacy database');
  await page.getByLabel('Source').selectOption({ label: 'Legacy SQL Server (Demo)' });
  await expect(page.getByLabel('Target')).toHaveCount(0);
  await page.getByTestId('create-project').click();

  await expect(page.getByRole('heading', { name: 'Understand the legacy database' })).toBeVisible();
  await expect(page.getByText('Data analysis', { exact: true }).first()).toBeVisible();

  // 3. Run an analysis over two tables, examining every record.
  await page.getByTestId('new-analysis').click();
  const customerRow = page.getByText('dbo.Customer', { exact: true });
  await expect(customerRow).toBeVisible({ timeout: 60_000 });
  await page.getByRole('checkbox', { name: 'Customer' }).check();
  await page.getByRole('checkbox', { name: 'Order', exact: true }).check();
  await page.getByTestId('start-analysis').click();

  // 4. The results screen. Counts are exact because every record was read.
  await expect(page.getByTestId('analysis-tables')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText('These numbers are exact')).toBeVisible();
  const tables = page.getByTestId('analysis-tables');
  await expect(tables).toContainText('dbo.Customer');
  await expect(tables).toContainText('dbo.Order');
  await expect(tables).toContainText('26');

  // An order points at a customer, so customers load first and the dependency is shown on the row.
  const orderRow = tables.getByRole('row').filter({ hasText: 'dbo.Order' });
  await expect(orderRow).toContainText('dbo.Customer');

  // 5. Drill into one table's columns: this is the column-level profile of the real source.
  // The first row is dbo.Customer, because the load order puts it before the table that needs it.
  await tables.getByRole('row').filter({ hasText: 'dbo.Customer' }).first().click();
  const columns = page.getByTestId('analysis-columns');
  await expect(columns).toBeVisible();
  await expect(columns).toContainText('CustomerName');
  await expect(columns).toContainText('Email');

  // 6. Findings: what the source contradicts about itself, with no target in sight.
  await page.getByRole('tab', { name: /Findings/ }).click();
  await expect(page.getByTestId('analysis-findings')).toBeVisible();

  // 7. Relationships: the same dependencies drawn, which is also the order a migration loads in.
  await page.getByRole('tab', { name: /Relationships/ }).click();
  const erd = page.getByTestId('erd');
  await expect(erd).toBeVisible({ timeout: 60_000 });
  await expect(erd).toContainText('Customer');
  await expect(erd).toContainText('Order');
  // The toggle says what it does in words on the screen, not only to a screen reader.
  await expect(page.getByText('Show linking columns')).toBeVisible();
  // The column that ties the two tables together is named on the arrow between them.
  await expect(erd.getByTestId('erd-edge-label')).toHaveText(['CustomerId']);
  await page.getByRole('checkbox', { name: 'Show linking columns' }).uncheck();
  await expect(erd.getByTestId('erd-edge-label')).toHaveCount(0);
  // config.Region was never analysed, so the diagram says it cannot draw that reference rather
  // than dropping it.
  await expect(page.getByText(/point outside this analysis/)).toBeVisible();
  await expect(page.getByText('config.Region')).toBeVisible();

  // 8. The mapping workbook downloads as a real spreadsheet.
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Mapping workbook' }).first().click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.xlsx$/);

  // 9. A migration project that starts from that analysis.
  await page.goto('/projects');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-kind').selectOption('MIGRATION');
  await page.getByTestId('project-name').fill('Legacy customers into QA');
  await page.getByLabel('Source').selectOption({ label: 'Legacy SQL Server (Demo)' });
  await page.getByLabel('Target').selectOption({ label: 'DeepTrics QA' });
  await page.getByLabel('Based on analysis').selectOption({ label: 'Understand the legacy database' });
  await page.getByTestId('create-project').click();

  await expect(page.getByRole('heading', { name: 'Legacy customers into QA' })).toBeVisible();
  // The project shows what the analysis it was built on measured.
  await expect(page.getByText('Based on', { exact: true })).toBeVisible();
  await expect(page.getByTestId('project-plans')).toContainText('No plans in this project');

  expect(consoleErrors).toEqual([]);
});
