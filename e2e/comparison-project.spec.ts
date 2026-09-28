import { expect, test } from '@playwright/test';

/**
 * Comparison and validation, as a person does it.
 *
 * The product is sold on this half standing alone: somebody who is not migrating anything still
 * wants to know whether two systems agree. So the journey here starts at a new project and ends at
 * a result, without a migration anywhere in it.
 */
test('compare two systems and read the result', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (msg) => msg.type() === 'error' && problems.push(msg.text()));
  page.on('pageerror', (err) => problems.push(err.message));

  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();

  // Connections have to be discovered before a project can name one.
  await page.goto('/environments');
  await expect(page.getByTestId('env-card-DeepTrics QA')).toBeVisible({ timeout: 60_000 });

  await page.goto('/projects?new=1');
  await page.getByTestId('project-kind').selectOption('COMPARISON');
  // The form asks for two sides, and calls neither of them a target.
  await expect(page.getByLabel('Side A')).toBeVisible();
  await expect(page.getByLabel('Side B')).toBeVisible();
  await page.getByTestId('project-name').fill('Dev against QA');
  await page.getByLabel('Side A').selectOption({ label: 'DeepTrics Development' });
  await page.getByLabel('Side B').selectOption({ label: 'DeepTrics QA' });
  await page.getByTestId('create-project').click();
  await expect(page.getByRole('heading', { name: 'Dev against QA' })).toBeVisible();

  // A comparison project offers no way to write anywhere.
  await expect(page.getByRole('button', { name: /Execute|Migrate/ })).toHaveCount(0);

  await page.getByTestId('new-comparison').click();
  await page.getByTestId('comparison-name').fill('First reconciliation');
  // The setup proposes the pairings; the person confirms them.
  await expect(page.getByLabel('account ↔ account')).toBeVisible({ timeout: 120_000 });
  // Each chosen pair states what it will match records on, rather than deciding it invisibly.
  const keySelect = page.getByLabel('Match records on').first();
  await expect(keySelect).toBeVisible();
  expect(await keySelect.inputValue()).not.toBe('');
  await page.getByTestId('start-comparison').click();

  await expect(page.getByRole('heading', { name: 'First reconciliation' })).toBeVisible();
  await expect(page.getByTestId('comparison-totals')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('comparison-tables')).toBeVisible();

  // The result says what was compared, and the differences are listed with their key.
  const differences = page.getByTestId('comparison-differences');
  await expect(differences).toBeVisible();
  await differences.getByLabel('Filter by difference').selectOption('VALUE_DIFFERS');
  await expect(differences).toBeVisible();

  expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
});
