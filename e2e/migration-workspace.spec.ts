import { expect, test } from '@playwright/test';

/**
 * A migration, as a workspace rather than as nine pages.
 *
 * The product this replaces answered "are we ready?" with "I completed step 6", because readiness lived
 * on a page you reached by pressing Continue four times and could not return to without starting again.
 * The assertion that matters most here is negative: **the nine-step stepper is not the way through.**
 *
 * One long walk rather than several short ones. `/api/auth/demo-login` is rate limited to fifteen a
 * minute deliberately, and a file that signs in six times pushes the whole suite over that ceiling — the
 * tests are then fine and the suite has run out of allowance, which is a confusing way to fail.
 */
test('a migration is one workspace, from empty to configured', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console — ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`page error — ${err.message}`));

  const tag = Date.now().toString(36).slice(-5);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();

  // The connections have to exist before anything can be migrated between them.
  await page.goto('/environments');
  await expect(page.getByTestId('env-card-DeepTrics QA')).toBeVisible({ timeout: 60_000 });

  // --- a migration is created from a name ------------------------------------
  /*
   * Not from a connection. "New migration → Connections" is the behaviour §7 forbids: it sent somebody
   * to a different page before they had made anything, and the half-filled form they abandoned to go
   * there was the most common way to lose the name they had just typed.
   */
  await page.goto('/projects?new=1');
  await page.getByTestId('project-kind').selectOption('MIGRATION');
  await page.getByTestId('project-name').fill(`CRM modernization ${tag}`);
  await page.getByTestId('create-project').click();

  // --- and lands in its own workspace ----------------------------------------
  await page.waitForURL(/\/migration\/[0-9a-f-]{36}/);
  const workspace = page.url();
  await expect(page.getByRole('heading', { name: `CRM modernization ${tag}` })).toBeVisible();

  // The negative claim this phase exists for.
  await expect(page.getByRole('navigation', { name: 'Migration workflow' })).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText('Step 1');

  // --- empty, not broken -----------------------------------------------------
  await expect(page.getByTestId('migration-status')).toHaveText('Draft');
  await expect(page.getByTestId('migration-empty')).toBeVisible();
  await expect(page.getByText('Migration not configured')).toBeVisible();
  await expect(page.getByText(/Migration readiness/)).toContainText('Not assessed');
  // Both ends are shown as missing rather than as a failed step.
  const ends = page.getByTestId('migration-ends');
  await expect(ends).toContainText('No source data');
  await expect(ends).toContainText('Not selected');

  // --- the destination is chosen inside the migration ------------------------
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByTestId('choose-destination').click();
  await page.getByTestId('destination-connection').selectOption({ label: 'DeepTrics UAT' });
  await page.getByTestId('save-destination').click();
  await expect(page.getByTestId('migration-ends')).toContainText('DeepTrics UAT', { timeout: 30_000 });
  // A simulated destination never looks executable.
  await expect(page.getByRole('main')).toContainText('Simulated target');

  // --- source data, through the same picker the dataset experience uses ------
  await page.getByTestId('add-source-data').click();
  await page.getByTestId('source-connection').selectOption({ label: 'DeepTrics Development' });
  await page.getByTestId('object-account').check();
  await page.getByTestId('object-contact').check();
  await expect(page.getByTestId('save-source-data')).toHaveText('Use 2 tables');
  await page.getByTestId('save-source-data').click();

  // --- which becomes the migration's scope ----------------------------------
  await expect(page.getByTestId('scope-row')).toHaveCount(2, { timeout: 60_000 });
  const scope = page.getByTestId('migration-scope-list');
  await expect(scope).toContainText('account');
  await expect(scope).toContainText('contact');

  // --- and the overview answers the questions in one screen ------------------
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByTestId('migration-scope')).toContainText('2 datasets');
  await expect(page.getByTestId('migration-readiness')).toBeVisible();
  await expect(page.getByTestId('migration-last-run')).toContainText('None yet');
  // The one thing to do next, as an action rather than as a stage.
  await expect(page.getByTestId('migration-next-action')).toBeVisible();

  /*
   * Adding a third table must not restart the migration. The engine keeps the entity rows that stay, so
   * the mapping already done on `account` and `contact` survives; a rebuild that dropped and recreated
   * every row would discard it silently.
   */
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByTestId('add-source-data').click();
  await page.getByTestId('object-product').check();
  await page.getByTestId('save-source-data').click();
  await expect(page.getByTestId('scope-row')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByTestId('migration-scope-list')).toContainText('account');

  // Never left the workspace to do any of it.
  expect(page.url().split('?')[0]).toBe(workspace.split('?')[0]);
  expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
});
