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

test('adding a connection happens here, without leaving the form', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();

  await page.goto('/projects?new=1');
  await page.getByTestId('project-name').fill('Keeps what I typed');
  await page.getByTestId('add-connection-link').click();

  // The connection picker opens over the form. It used to navigate to the connections page, which
  // threw away everything typed so far.
  await expect(page.getByTestId('connector-sqlserver')).toBeVisible();
  /*
   * Files are offered here too, and were not.
   * Hiding the card on this one screen is what the owner found: the connections screen offered
   * "Upload from your computer" and this dialog did not, which is one product giving two answers
   * to "can I upload a spreadsheet". Choosing it keeps everything typed into the form.
   */
  const upload = page.getByTestId('connector-upload');
  await expect(upload).toBeVisible();
  await expect(upload).toContainText('Upload from your computer');

  // Closing without choosing anything still keeps the form, which is what this test was for.
  // The footer button, not the dialog's × which shares its accessible name.
  await page.getByRole('dialog', { name: 'Add connection' }).getByText('Close', { exact: true }).click();
  await expect(page.getByTestId('project-name')).toHaveValue('Keeps what I typed');

  /*
   * And choosing the upload card keeps it too. It closes the dialog, because the next step is
   * creating the project and then the file goes into it; what it must not do is throw away the
   * name somebody has already typed.
   */
  await page.getByTestId('add-connection-link').click();
  await page.getByTestId('connector-upload').click();
  await expect(page.getByRole('dialog', { name: 'Add connection' })).toHaveCount(0);
  await expect(page.getByTestId('project-name'), 'the form is still here, still filled in').toHaveValue(
    'Keeps what I typed',
  );
  await expect(page).toHaveURL(/\/projects/);
});
