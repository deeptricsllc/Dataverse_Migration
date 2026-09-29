import { expect, test } from '@playwright/test';

/**
 * The New Project form says what it is asking for.
 *
 * It did not. `Select` puts its label in `aria-label` and renders nothing, so choosing a kind
 * produced two or three unlabelled "Choose…" boxes: no way to tell the source from the target, or
 * to know what the third one was for at all.
 *
 * The journeys did not catch it, and the reason matters — `getByLabel` matches an accessible name,
 * so every existing test was satisfied by a label no sighted person could see. These assertions are
 * therefore about what is *visible*: the label element, and the sentence under it.
 */
test('every control in the new project form says what it is for', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));

  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();
  await page.goto('/environments');
  await expect(page.getByTestId('env-card-DeepTrics QA')).toBeVisible({ timeout: 60_000 });

  await page.goto('/projects?new=1');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // --- analysis: one source, and it is named on screen ------------------------------------------
  await page.getByTestId('project-kind').selectOption('ANALYSIS');
  await expect(dialog.locator('label[for="project-source"]')).toHaveText(/Source/);
  await expect(dialog.getByText('The system this project reads. It is never written to.')).toBeVisible();
  // There is a way to create the thing the picker is asking for.
  await expect(dialog.getByTestId('add-connection-link')).toBeVisible();

  // --- migration: which one is read and which one is written to -------------------------------
  await page.getByTestId('project-kind').selectOption('MIGRATION');
  await expect(dialog.locator('label[for="project-source"]')).toHaveText(/Source/);
  await expect(dialog.locator('label[for="project-target"]')).toHaveText(/Target/);
  await expect(dialog.getByText('Where the data is read from.')).toBeVisible();
  await expect(dialog.getByText(/Where the data will be written/)).toBeVisible();
  // The third box used to be an unexplained "None".
  await expect(dialog.locator('label[for="project-analysis"]')).toHaveText(/Based on analysis/);
  await expect(dialog.locator('label[for="project-analysis"]')).toContainText('optional');
  await expect(dialog.getByText(/the mapping workbook carries the statistics/)).toBeVisible();

  // --- comparison: two sides, told apart --------------------------------------------------------
  await page.getByTestId('project-kind').selectOption('COMPARISON');
  await expect(dialog.locator('label[for="project-source"]')).toHaveText(/Side A/);
  await expect(dialog.locator('label[for="project-target"]')).toHaveText(/Side B/);
  await expect(dialog.getByText(/The first of the two datasets to reconcile/)).toBeVisible();
  await expect(dialog.getByText(/It may be the same connection as side A/)).toBeVisible();

  expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
});

test('the form offers a way out to create a connection', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();

  await page.goto('/projects?new=1');
  await page.getByTestId('add-connection-link').click();

  // Lands on the connections page with the form already open, rather than on the list with the
  // button still to find.
  await expect(page).toHaveURL(/\/environments\?new=1/);
  await expect(page.getByRole('radio', { name: /CSV \/ Excel \/ XML file/ })).toBeVisible();
});
