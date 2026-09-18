import { expect, test, type Page } from '@playwright/test';

/**
 * The cross-provider journey, in the browser:
 * demo login → connections → legacy SQL Server as source → Dataverse QA as target → analyze →
 * select SQL tables → map tables → map fields → map choice values → preflight → execute →
 * validate → export the reconciliation.
 */
test('demo journey: legacy SQL Server into Dataverse QA', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  // 1. Sign in
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();

  // 2. Connections: the simulated legacy database is offered alongside the Dataverse environments
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Connections' }).click();
  const sqlCard = page.getByTestId('env-card-Legacy SQL Server (Demo)');
  await expect(sqlCard).toBeVisible({ timeout: 60_000 });
  await expect(sqlCard).toContainText('SQL Server');
  await expect(sqlCard).toContainText('IIC_Legacy');

  await setWorkspace(page, 'Legacy SQL Server (Demo)', 'DeepTrics QA');

  // 3. Verify both connections, then analyze. The SQL test is read-only: it reads the server
  // version and the catalog, and reports write permission as "not tested".
  const verify = page.getByRole('button', { name: 'Verify both connections' });
  if (await verify.count()) await verify.click();
  await expect(sqlCard.getByText('Connected', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Continue to Analyze' }).click();
  await expect(page).toHaveURL(/\/compare/);
  await clickEither(page, /^Analyze now$|^Re-analyze \(refresh metadata\)$/);
  await expect(page.getByRole('button', { name: /Tables compared/ })).toBeVisible({ timeout: 120_000 });

  // 4. Select the SQL tables to migrate. Navigating directly keeps this independent of whether
  // the deployment already holds a comparison or a plan for this pair.
  await expect(page.getByRole('button', { name: 'Continue: Select tables' })).toBeVisible();
  await page.goto('/migration/new');
  await expect(page.getByRole('heading', { name: 'Select tables to migrate' })).toBeVisible();
  await selectTable(page, 'config.Region');
  await selectTable(page, 'dbo.Customer');
  await clickEither(page, /Generate migration plan|Update migration plan|Continue: Review dependencies/);

  // 5. Dependencies: the foreign key from Customer to Region orders the two tables
  await expect(page.getByTestId('migration-order')).toBeVisible({ timeout: 60_000 });
  const order = await page.getByTestId('migration-order').innerText();
  expect(order.indexOf('Region')).toBeLessThan(order.indexOf('Customer'));
  await page.getByRole('button', { name: /Continue: Map fields/ }).click();

  // 5. Table mapping — a suggestion has to be confirmed before it can run
  await expect(page.getByTestId('object-mapping')).toBeVisible();
  await expect(page.getByText('Suggested, not decided')).toBeVisible();
  await page.getByTestId('confirm-object-mapping').click();
  await expect(page.getByText('Suggested, not decided')).toBeHidden();

  // 7. Field mapping: SQL columns onto Dataverse columns, with a compatibility verdict
  await mapField(page, 'RegionName', 'dtx_name');
  await mapField(page, 'RegionCode', 'dtx_code');

  await page.getByTestId('plan-table-dbo.Customer').click();
  await expect(page.getByText('Suggested, not decided')).toBeVisible();
  await page.getByTestId('confirm-object-mapping').click();

  // 6b. Configure the cleanup: TRIM the padded names, normalize the emails
  await mapField(page, 'CustomerName', 'name');
  await page.getByTestId('edit-transform-CustomerName').click();
  await expect(page.getByRole('dialog', { name: /Transformations/ })).toBeVisible();
  await page.getByTestId('template-trim-text').click();
  await expect(page.getByTestId('rule-TRIM')).toBeVisible();
  // The preview runs the server's engine over real values, so quotes make the padding visible.
  await expect(page.getByTestId('preview-rows')).toContainText('"  ');
  await page.getByTestId('save-transformations').click();
  await expect(page.getByRole('dialog', { name: /Transformations/ })).toBeHidden();
  await expect(page.getByTestId('mapping-CustomerName')).toContainText('trim');

  await mapField(page, 'Email', 'emailaddress1');
  await page.getByTestId('edit-transform-Email').click();
  await page.getByTestId('template-normalize-email').click();
  await expect(page.getByTestId('rule-LOWERCASE')).toBeVisible();
  await page.getByTestId('save-transformations').click();

  // 6c. The record-level before and after
  await page.getByTestId('toggle-record-preview').click();
  await expect(page.getByTestId('record-preview')).toContainText('Transformed');

  await mapField(page, 'CustomerNumber', 'accountnumber');
  await mapField(page, 'RegionId', 'dtx_regionid');
  // A wider source column than the target is reported as lossy before anything is written.
  await expect(page.getByTestId('mapping-CustomerName')).toContainText('lossy');

  // 8. Choice mapping: SQL text into a Dataverse choice, value by value
  await mapField(page, 'Industry', 'industrycode');
  await page.getByTestId('choice-map-Industry').click();
  await expect(page.getByRole('dialog', { name: /Choice mapping/ })).toBeVisible();
  // The value nobody planned for is visible here, read from the data itself.
  await expect(page.getByTestId('choice-row-Aerospace')).toBeVisible();
  // Anything the target has no choice for is excluded explicitly — a decision, not a default.
  const dialog0 = page.getByRole('dialog', { name: /Choice mapping/ });
  for (;;) {
    const unmapped = dialog0.getByRole('row').filter({ hasText: 'unmapped' }).first();
    if ((await unmapped.count()) === 0) break;
    await unmapped.getByRole('button', { name: 'Exclude' }).click();
  }
  await page.getByTestId('save-choice-map').click();
  await expect(page.getByRole('dialog', { name: /Choice mapping/ })).toBeHidden();

  // 9. A SQL identity key cannot be carried into Dataverse, so match on a business key
  await setMatchByBusinessKey(page, 'accountnumber');
  await page.getByTestId('plan-table-config.Region').click();
  await setMatchByBusinessKey(page, 'dtx_code');

  // 10. Review: SQL has no ownership or plug-ins, so those Dataverse options are not offered
  await page.getByRole('button', { name: 'Continue: Review plan' }).click();
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  await expect(page.getByText('Microsoft Dataverse').first()).toBeVisible();
  await expect(page.getByTestId('issue-BLOCKER')).toHaveCount(0);
  await page.getByTestId('open-preflight').click();
  await page.getByTestId('run-preflight').click();
  await expect(page.getByRole('heading', { name: 'By table' })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Create', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Export preflight CSV' })).toBeVisible();
  await page.goBack();

  // 11. Execute
  await page.getByRole('button', { name: 'Execute migration' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm migration execution' });
  const ack = dialog.getByTestId('ack-warnings');
  if (await ack.isVisible().catch(() => false)) await ack.check();
  await dialog.getByLabel(/Type the target environment name/).fill('DeepTrics QA');
  await dialog.getByRole('button', { name: /Write data to DeepTrics QA/ }).click();

  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByText(/Completed/).first()).toBeVisible({ timeout: 180_000 });

  // 12. Validate the SQL source against the Dataverse target
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page).toHaveURL(/\/validation\//);
  await expect(page.getByRole('heading', { name: 'Results by table' })).toBeVisible({ timeout: 120_000 });
  // 13. The reconciliation exports a team can work from outside the application
  await expect(page.getByRole('link', { name: 'Export summary' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Export differences' })).toBeVisible();

  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});

/** Clicks whichever of the alternative buttons the current state offers. */
async function clickEither(page: Page, name: RegExp) {
  const button = page.getByRole('button', { name });
  await expect(button.first()).toBeVisible();
  await button.first().click();
}

async function setWorkspace(page: Page, source: string, target: string) {
  const sourceCard = page.getByTestId(`env-card-${source}`);
  const targetCard = page.getByTestId(`env-card-${target}`);
  const sourceButton = sourceCard.getByRole('button', { name: /Set as source/ });
  if (await sourceButton.isVisible().catch(() => false)) await sourceButton.click();
  const targetButton = targetCard.getByRole('button', { name: /Set as target/ });
  if (await targetButton.isVisible().catch(() => false)) await targetButton.click();
  await expect(page.getByTestId('workspace-source')).toContainText(source);
  await expect(page.getByTestId('workspace-target')).toContainText(target);
}

async function selectTable(page: Page, logicalName: string) {
  // Against a deployment, an earlier run may already have selected this table.
  const box = page.getByTestId(`table-row-${logicalName}`).getByRole('checkbox');
  await expect(box).toBeVisible();
  if (!(await box.isChecked())) await box.click();
  await expect(box).toBeChecked();
}

async function mapField(page: Page, sourceField: string, targetField: string) {
  const row = page.getByTestId(`mapping-${sourceField}`);
  await row.getByLabel(`Target for ${sourceField}`).selectOption({ value: targetField });
  await expect(row).toContainText(targetField);
}

async function setMatchByBusinessKey(page: Page, column: string) {
  await page.getByLabel('Match strategy').selectOption({ value: 'BUSINESS_KEY' });
  const box = page.getByRole('checkbox', { name: new RegExp(column) }).first();
  await box.click();
  await expect(box).toBeChecked();
}
