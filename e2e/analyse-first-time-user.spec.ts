import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { writeXlsx } from '../server/src/lib/xlsx';

/**
 * The whole Analyze journey, as a person who has never seen this product does it.
 *
 * Every step is a click. Nothing here reaches past the interface to set up a state the user would
 * have had to reach themselves — the one exception would be a state the product refuses to create,
 * and where that happens this test says so rather than forcing it.
 *
 * The data is deliberately bad, because a clean file proves the engine runs and proves nothing about
 * whether the findings are worth reading. This workbook carries the problems a real export carries:
 * a sheet with no reliable identifier, duplicate customer numbers, a third of the emails missing,
 * dates written as Excel serial numbers, money stored as text with currency symbols, and trailing
 * whitespace. Each one has a different consequence for a migration, and the test reads what the
 * product says about them.
 */

const CAPTURE_DIR = process.env.CAPTURE_DIR;
let step = 0;
async function shot(page: Page, name: string) {
  step += 1;
  if (!CAPTURE_DIR) return;
  for (const w of [
    { label: '1440x900', width: 1440, height: 900 },
    { label: '1920x1080', width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.waitForTimeout(300);
    const dir = `${CAPTURE_DIR}/${w.label}`;
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${String(step).padStart(2, '0')}-${name}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/**
 * Wait until every dataset has finished, rather than until the word "Analysed" appears.
 *
 * The first dataset to finish puts "Analysed" on the screen while the rest are still running, so
 * matching that text photographs a half-finished project and reads a readiness score computed from
 * part of it. That is how the overview defect below went unnoticed for a run. The header's amber
 * "N not analysed yet" is the signal that is absent only when the work is actually done.
 */
async function waitForAllAnalysed(page: Page) {
  const main = page.getByRole('main');
  await expect(main).toContainText('Analysed', { timeout: 600_000 });
  await expect(main).not.toContainText('not analysed yet', { timeout: 600_000 });
  await expect(page.getByRole('button', { name: /Analysing/ })).toHaveCount(0, { timeout: 600_000 });
}

/** An export as it actually arrives from a finance system: several sheets, several kinds of wrong. */
function messyEnterpriseWorkbook(): Buffer {
  const customers = Array.from({ length: 60 }, (_, i) => [
    // Twelve of the sixty repeat an earlier customer number: a double export, which is the
    // single most expensive thing to discover after a migration rather than before it.
    i < 48 ? `CUST-${1000 + i}` : `CUST-${1000 + (i - 48)}`,
    i % 7 === 0 ? `  Northwind Trading  ` : `Customer ${i}`,
    // A third have no email at all.
    i % 3 === 0 ? '' : i % 11 === 0 ? 'not-an-email' : `buyer${i}@example.test`,
    // Money as text, with symbols and thousands separators.
    i % 5 === 0 ? `$1,${200 + i}.50` : `${1000 + i * 7}`,
    // Dates as Excel serial numbers.
    String(44000 + i),
  ]);
  const contacts = Array.from({ length: 40 }, (_, i) => [
    `Contact ${i}`,
    `CUST-${1000 + (i % 48)}`,
    i % 4 === 0 ? '' : `contact${i}@example.test`,
  ]);
  const orders = Array.from({ length: 90 }, (_, i) => [
    `ORD-${5000 + i}`,
    `CUST-${1000 + (i % 48)}`,
    String(44100 + (i % 200)),
    `${(i % 9) * 125.25}`,
  ]);
  return writeXlsx([
    {
      name: 'Customers',
      columns: [
        { header: 'customer_number' },
        { header: 'customer_name' },
        { header: 'email' },
        { header: 'credit_limit' },
        { header: 'opened_on' },
      ],
      rows: customers,
    },
    {
      // No identifier at all: the finding a migration architect needs before anything else.
      name: 'Contacts',
      columns: [{ header: 'contact_name' }, { header: 'customer_number' }, { header: 'email' }],
      rows: contacts,
    },
    {
      name: 'Orders',
      columns: [
        { header: 'order_number' },
        { header: 'customer_number' },
        { header: 'ordered_on' },
        { header: 'total' },
      ],
      rows: orders,
    },
    { name: 'Read Me', columns: [{ header: 'note' }], rows: [['Exported monthly']] },
  ]);
}

test('a first-time user can analyse a messy export and understand the result', async ({ page }) => {
  test.setTimeout(900_000);
  const tag = Date.now().toString(36).slice(-5);
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });

  // --- 1. arrive, with no idea what this is --------------------------------
  await page.goto('/');
  await shot(page, 'landing');
  await page.getByTestId('try-demo-primary').first().click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();
  await shot(page, 'home-first-visit');

  // --- 2. create an analysis project --------------------------------------
  await page.goto('/projects');
  await shot(page, 'projects-empty-or-list');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-kind').selectOption('ANALYSIS');
  await page.getByTestId('project-name').fill(`Finance export review ${tag}`);
  await shot(page, 'new-project-form');
  await page.getByTestId('create-project').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  const projectId = page.url().split('/projects/')[1]!.split(/[?#]/)[0]!;
  await page.goto(`/analysis/${projectId}`);
  await shot(page, 'project-with-no-data');

  /*
   * 3. Attempt analysis without choosing a file.
   *
   * There is nothing to press. That is the fix, stated as the product rather than as an error: a
   * project with no data offers "Add dataset" and does not offer an action that cannot succeed.
   * Forcing the old state would mean reaching past the interface to build something the product
   * refuses to build, which would be testing a screen nobody can reach.
   */
  await expect(page.getByTestId('analyse')).toHaveCount(0);
  await expect(page.getByRole('main')).toContainText(/No datasets|Add dataset/);

  // --- 4 & 5. upload the workbook and read the preview ---------------------
  await page.getByTestId('add-dataset').click();
  await shot(page, 'add-dataset-choose-a-connector');
  await page.getByTestId('connector-excel').click();
  await page.getByTestId('dataset-file-input').setInputFiles({
    name: 'FinanceExport.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: messyEnterpriseWorkbook(),
  });
  const preview = page.getByTestId('dataset-preview');
  await preview.waitFor({ timeout: 120_000 });
  // Every sheet is offered, with its shape, before anything is imported.
  await expect(preview).toContainText('Customers');
  await expect(preview).toContainText('Contacts');
  await expect(preview).toContainText('Orders');
  await shot(page, 'preview-every-sheet-before-choosing');

  // --- 6. choose specific sheets, not the whole workbook -------------------
  const boxes = preview.getByRole('checkbox');
  const sheetCount = await boxes.count();
  expect(sheetCount, 'every sheet is a choice').toBeGreaterThan(1);
  // Clear whatever is pre-ticked, then choose three of the four deliberately.
  for (let i = 0; i < sheetCount; i++) {
    if (await boxes.nth(i).isChecked()) await boxes.nth(i).uncheck();
  }
  for (const sheet of ['Customers', 'Contacts', 'Orders']) {
    // The control names what ticking it does: "Analyse Customers".
    await preview.getByRole('checkbox', { name: new RegExp(`Analyse .*${sheet}`, 'i') }).check();
  }
  await shot(page, 'three-of-four-sheets-chosen');
  await page.getByTestId('confirm-add-dataset').click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(3, { timeout: 120_000 });
  // The sheet nobody chose is not in the project.
  await expect(page.getByRole('main')).not.toContainText('Read Me');
  await shot(page, 'three-datasets-one-per-sheet');

  // --- 7. run it -----------------------------------------------------------
  const analyse = page.getByTestId('analyse');
  await expect(analyse).toBeEnabled();
  await analyse.click();
  await waitForAllAnalysed(page);
  await shot(page, 'analysed');

  // --- 8. the findings -----------------------------------------------------
  await page.getByRole('tab', { name: /Findings/ }).click();
  const findings = page.getByRole('main');
  await expect(findings).toBeVisible();
  await shot(page, 'findings');
  /*
   * What the data was built to contain. Asserted by consequence rather than by rule name: a reader
   * of this report is a migration architect, and "no reliable key" is the sentence that changes
   * what they do next.
   */
  const text = (await findings.textContent()) ?? '';
  expect(text, 'the duplicate customer numbers').toMatch(/duplicat/i);
  expect(text, 'the missing emails').toMatch(/empty|blank|missing|null/i);

  // --- 9. readiness, and how it was worked out -----------------------------
  await page.getByRole('tab', { name: /Overview/ }).click();
  await expect(page.getByRole('main')).toContainText(/readiness|Ready|Not ready/i);
  await shot(page, 'readiness-and-how-it-was-calculated');

  // --- 10. export ----------------------------------------------------------
  /*
   * Required, not skipped.
   *
   * This was written with an `if (visible)` around it, so when no export control existed the step
   * passed in silence — and the screenshot of "export" was a picture of the overview. A step that
   * can quietly not happen is not a step.
   */
  const exportLink = page.getByRole('link', { name: /Export findings/ });
  await expect(exportLink, 'the report can be taken away').toBeVisible();
  const href = await exportLink.getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.status(), `export ${href}`).toBe(200);
  const csv = await res.text();
  // The file is the findings the screen shows, with the reasoning behind each one.
  expect(csv).toContain('Why it matters');
  expect(csv).toContain('What to do');
  expect(csv, 'the critical finding is in the file').toMatch(/No reliable record identifier/i);
  expect(csv.split('\n').length, 'one row per finding').toBeGreaterThan(5);
  await shot(page, 'export');

  // --- 11. a second source -------------------------------------------------
  await page.getByRole('tab', { name: /Datasets/ }).click();
  await page.getByTestId('add-dataset').click();
  await page.getByTestId('connector-csv').click();
  await page.getByTestId('dataset-file-input').setInputFiles({
    name: 'suppliers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'supplier_code,supplier_name,contact_email',
        ...Array.from(
          { length: 15 },
          (_, i) => `SUP-${200 + i},Supplier ${i},${i % 4 === 0 ? '' : `s${i}@example.test`}`,
        ),
      ].join('\n'),
    ),
  });
  await page.getByTestId('dataset-preview').waitFor({ timeout: 120_000 });
  await page.getByTestId('confirm-add-dataset').click();
  await page.getByRole('tab', { name: /Datasets/ }).click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(4, { timeout: 120_000 });
  await page.getByTestId('analyse').click();
  await waitForAllAnalysed(page);
  /*
   * Back to the dataset list to count them. Finishing an analysis puts the reader on the overview,
   * which is right — the summary is what they came for — and the rows live one tab over.
   */
  await page.getByRole('tab', { name: /Datasets/ }).click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(4, { timeout: 120_000 });
  await shot(page, 'second-source-analysed');
  await page.getByRole('tab', { name: /Overview/ }).click();
  /*
   * The summary counted only the datasets it had assessed while saying the project "contains" them,
   * so a project with four datasets and three analysed read "4 datasets" in the header and "contains
   * 3 datasets ... 81 out of 100" directly underneath. With everything analysed the two agree.
   */
  await expect(page.getByRole('main')).toContainText('contains 4 datasets');
  await shot(page, 'overview-across-four-datasets');

  // --- 12. come back later -------------------------------------------------
  await page.goto('/projects');
  await page.getByText(`Finance export review ${tag}`).first().click();
  await page.waitForURL(/\/(projects|analysis)\/[0-9a-f-]{36}/);
  await page.goto(`/analysis/${projectId}`);
  await expect(page.getByRole('main')).toContainText('205', { timeout: 120_000 });
  await page.getByRole('tab', { name: /Datasets/ }).click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(4, { timeout: 120_000 });
  await expect(page.getByRole('main')).toContainText('Analysed');
  await shot(page, 'reopened-later');

  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  expect(failedRequests, failedRequests.join('\n')).toEqual([]);
});
