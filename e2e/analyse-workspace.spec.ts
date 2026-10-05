import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeXlsx } from '../server/src/lib/xlsx';

/**
 * The whole Analyse workflow, done the way a consultant does it.
 *
 * Nothing here is seeded. The project is created through the dialog, the files go in through the file
 * input, the analysis is started by pressing the button, the decision is recorded through the control.
 * If any one of those is broken this fails — which is the only way to know the workspace is actually
 * self-sufficient rather than merely looking it.
 *
 * The assertion that matters most is negative: **the URL never leaves `/analysis/`.** The previous slice
 * reached a workable screen by sending people to the old project page for anything that wrote, and the
 * whole point of this one is that it no longer does.
 *
 * ## Why three long tests rather than ten short ones
 *
 * `/api/auth/demo-login` is rate limited to fifteen a minute, deliberately: each one seeds a workspace and
 * runs real work, so a flood there is a flood of jobs rather than of rows. A first draft of this file signed
 * in ten times and pushed the whole suite over that ceiling — three *other* specs began failing at their own
 * sign-in with twenty-second timeouts. The tests were fine; the suite had run out of allowance.
 *
 * Fewer, longer walks is the better shape for this anyway: a consultant does not sign in again between
 * adding a dataset and reading a finding, so neither should the test.
 */

/** Three small files with the problems a legacy extract has. Written to disk so the upload is real. */
const FIXTURES = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dvm-analyse-'));
  const rows = (header: string, make: (i: number) => string, n: number) =>
    [header, ...Array.from({ length: n }, (_, i) => make(i))].join('\r\n');

  writeFileSync(
    join(dir, 'Customers.csv'),
    rows(
      'customer_number,company,contact_email,legacy_notes',
      (i) =>
        // Every eleventh company name carries a trailing space; some addresses are malformed.
        `CUST-${String(1000 + i).padStart(5, '0')},${i % 11 === 0 ? 'Acme Ltd ' : 'Acme Ltd'},${
          i % 37 === 0 ? `broken${i}-at-example.com` : `person${i}@example.com`
        },`,
      120,
    ),
  );
  // No column here is both unique and populated, which is the critical finding.
  writeFileSync(
    join(dir, 'Contacts.csv'),
    rows(
      'first_name,last_name,email,customer_number',
      (i) => `Alex,Smith,person${i % 20}@example.com,CUST-${String(1000 + (i % 40)).padStart(5, '0')}`,
      100,
    ),
  );
  writeFileSync(
    join(dir, 'Orders.csv'),
    // order_date is an Excel serial: 45292 is 2024-01-01.
    rows(
      'order_reference,customer_number,order_date',
      (i) => `SO-${50000 + i},CUST-01000,${45292 + (i % 90)}`,
      150,
    ),
  );
  /*
   * A workbook shaped like the ones that arrive in real engagements: three sheets of data and two that
   * are notes. Written with the product's own writer so the file is a real .xlsx rather than a fixture
   * that only this reader understands.
   */
  writeFileSync(
    join(dir, 'CustomerMigration.xlsx'),
    writeXlsx([
      {
        name: 'Customers',
        columns: [{ header: 'customer_number' }, { header: 'company' }],
        rows: Array.from({ length: 40 }, (_, i) => [`CUST-${2000 + i}`, `Company ${i}`]),
      },
      {
        name: 'Contacts',
        columns: [{ header: 'contact_number' }, { header: 'full_name' }],
        rows: Array.from({ length: 30 }, (_, i) => [`CONT-${3000 + i}`, `Person ${i}`]),
      },
      {
        name: 'Orders',
        columns: [{ header: 'order_number' }, { header: 'total' }],
        rows: Array.from({ length: 60 }, (_, i) => [`ORD-${4000 + i}`, `${i * 25}`]),
      },
      { name: 'Instructions', columns: [{ header: 'step' }], rows: [['Export monthly']] },
      { name: 'Lookup Notes', columns: [{ header: 'note' }], rows: [['AU = Australia']] },
    ]),
  );
  return dir;
})();

const signIn = async (page: Page) => {
  await page.goto('/login');
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/auth/demo-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return r.status;
  });
  expect(status).toBe(200);
};

const projectIdOf = (url: string) => url.split('/analysis/')[1]!.split(/[?#]/)[0]!;

/** Creates the project through the dialog and lands in its workspace. */
const createProject = async (page: Page, name: string) => {
  await page.goto('/projects');
  await page.getByTestId('workflow-ANALYSIS').click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/analysis\//);
  return page.url();
};

/** Adds one CSV, through the gallery and the preview, exactly as a person would. */
const addDataset = async (page: Page, filename: string) => {
  await page.getByTestId('add-dataset').click();
  await page.getByTestId('connector-csv').click();
  await page.getByTestId('dataset-file-input').setInputFiles(join(FIXTURES, filename));
  await page.getByTestId('dataset-preview').waitFor({ timeout: 60_000 });
  await page.getByTestId('confirm-add-dataset').click();
  await page.getByTestId('add-dataset').waitFor({ timeout: 30_000 });
};

const runAnalysis = async (page: Page) => {
  const id = projectIdOf(page.url());
  await page.getByTestId('analyse').click();
  await expect
    .poll(
      async () =>
        page.evaluate(async (projectId) => {
          const a = (await (await fetch(`/api/projects/${projectId}/assessment`)).json()) as {
            datasets: { state: string }[];
          };
          return (
            a.datasets.length > 0 && a.datasets.every((d) => d.state === 'ANALYSED' || d.state === 'STALE')
          );
        }, id),
      { timeout: 180_000, message: 'every dataset should finish analysing' },
    )
    .toBe(true);
};

const assessment = (page: Page) =>
  page.evaluate(
    async (projectId) =>
      (await (await fetch(`/api/projects/${projectId}/assessment`)).json()) as {
        datasets: unknown[];
        runs: unknown[];
        findings: { table: string }[];
      },
    projectIdOf(page.url()),
  );

// ---------------------------------------------------------------------------

test('raw files become an assessment without ever leaving the workspace', async ({ page }) => {
  const seen: string[] = [];
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) seen.push(new URL(f.url()).pathname);
  });

  await signIn(page);
  const workspace = await createProject(page, 'Customer Data Modernization');

  // The empty state says what to do, rather than that there is nothing.
  await expect(page.getByText('Add your first dataset')).toBeVisible();

  // --- the gallery is honest about what is real -----------------------------
  await page.getByTestId('add-dataset').click();
  await expect(page.getByTestId('connector-csv')).toBeVisible();
  await expect(page.getByTestId('connector-sqlserver')).toBeVisible();
  await expect(page.getByTestId('connector-dataverse')).toContainText('Simulated');
  await expect(page.getByTestId('connector-dataverse')).toContainText('Never run against a real Dataverse');
  await expect(page.getByTestId('connector-azuresql')).toContainText('Simulated');

  // --- the preview shows what is in the file, and stores nothing -------------
  await page.getByTestId('connector-csv').click();
  await page.getByTestId('dataset-file-input').setInputFiles(join(FIXTURES, 'Orders.csv'));
  const preview = page.getByTestId('dataset-preview');
  await preview.waitFor({ timeout: 60_000 });
  await expect(preview).toContainText('150 rows');
  // The whole reason a preview exists: the integers are dates, and it says so before anything is created.
  await expect(preview).toContainText('Date, stored as an Excel serial number');
  expect((await assessment(page)).datasets, 'previewing must not add the dataset').toHaveLength(0);

  await page.getByTestId('confirm-add-dataset').click();
  await page.getByTestId('add-dataset').waitFor({ timeout: 30_000 });
  for (const file of ['Customers.csv', 'Contacts.csv']) await addDataset(page, file);

  await page.getByRole('tab', { name: /Datasets/ }).click();
  // Three single-table CSVs are three datasets, listed as themselves rather than as three connections.
  await expect(page.getByTestId('dataset-row')).toHaveCount(3);
  // Named after the data, not after the upload: `Customers.csv` is a dataset called Customers.
  for (const name of ['Orders', 'Customers', 'Contacts']) {
    await expect(page.getByTestId('dataset-name').filter({ hasText: name })).toHaveCount(1);
  }
  await expect(page.getByTestId('dataset-state').first()).toHaveText('Not analysed');

  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByText('Nothing has been analysed yet')).toBeVisible();

  await runAnalysis(page);
  await expect(page.getByTestId('readiness-score')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('executive-summary')).toContainText('3 datasets');

  /** The negative claim this phase exists for. */
  expect(
    seen.filter((p) => /^\/projects\/[0-9a-f-]{36}/.test(p)),
    'the workflow must never route to the legacy project page',
  ).toEqual([]);
  expect(page.url()).toBe(workspace);

  // --- and no migration vocabulary anywhere in it ----------------------------
  const main = page.getByRole('main');
  for (const section of ['Overview', 'Datasets', 'Findings']) {
    await page.getByRole('tab', { name: new RegExp(section) }).click();
    await expect(main).not.toContainText(/\bSOURCE\b/);
    await expect(main).not.toContainText(/\bTARGET\b/);
  }
  await expect(page.getByRole('link', { name: 'Change Environments' })).toHaveCount(0);

  /*
   * --- a workbook is not a table ---------------------------------------------
   *
   * The sheets are chosen. Importing all five would put "Instructions" and "Lookup Notes" into the
   * analysis as datasets, where they would be profiled, produce findings about a column called `step`,
   * and pull down a readiness score that is supposed to describe customer data.
   */
  await page.getByTestId('add-dataset').click();
  await page.getByTestId('connector-excel').click();
  await page.getByTestId('dataset-file-input').setInputFiles(join(FIXTURES, 'CustomerMigration.xlsx'));
  const workbook = page.getByTestId('dataset-preview');
  await workbook.waitFor({ timeout: 60_000 });
  await expect(page.getByText('5 sheets detected')).toBeVisible();
  // The identifier question is answered here, before anything is stored.
  await expect(workbook).toContainText('customer_number looks like a possible record identifier');

  await page.getByTestId('sheet-Instructions').uncheck();
  await page.getByTestId('sheet-Lookup Notes').uncheck();
  await expect(page.getByTestId('confirm-add-dataset')).toHaveText('Add 3 datasets');
  await page.getByTestId('confirm-add-dataset').click();
  await page.getByTestId('add-dataset').waitFor({ timeout: 30_000 });

  // --- and each sheet is listed as the dataset it is -------------------------
  await page.getByRole('tab', { name: /Datasets/ }).click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(6);
  for (const sheet of ['Customers', 'Contacts', 'Orders']) {
    await expect(page.getByTestId('dataset-row').filter({ hasText: `${sheet} sheet` })).toHaveCount(1);
  }
  // The two sheets that are not data were never imported, so they are not datasets.
  await expect(page.getByRole('main')).not.toContainText('Instructions');
  await expect(page.getByRole('main')).not.toContainText('Lookup Notes');

  // --- a dataset can be renamed and removed ---------------------------------
  const orders = page.getByTestId('dataset-row').filter({ hasText: 'Orders sheet' });
  await orders.getByTestId('rename-dataset').click();
  const renameDialog = page.getByRole('dialog', { name: 'Rename dataset' });
  await renameDialog.getByLabel('Name').fill('Sales orders');
  await page.getByTestId('confirm-rename').click();
  await expect(page.getByTestId('dataset-row').filter({ hasText: 'Sales orders' })).toHaveCount(1);

  // Six datasets is enough for a filter to be worth having, and it filters.
  await page.getByTestId('dataset-filter').fill('Sales');
  await expect(page.getByTestId('dataset-row')).toHaveCount(1);
  await page.getByTestId('dataset-filter').fill('');

  /*
   * Removing one says what it costs before it does it: the rows go, and the analyses that profiled them
   * stay, so an assessment somebody has already read does not quietly change.
   */
  const contacts = page.getByTestId('dataset-row').filter({ hasText: 'Contacts sheet' });
  await contacts.getByTestId('remove-dataset').click();
  await page.getByTestId('confirm-remove').click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(5);

  /*
   * --- a database is not a dataset either -----------------------------------
   *
   * Choosing a connection used to be the end of this journey, and it added the whole database — every
   * table in every schema, including the audit tables and the staging copies. The person had asked for
   * two tables.
   */
  await page.getByTestId('add-dataset').click();
  await page.getByTestId('connector-sqlserver').click();

  /*
   * Creating a connection happens here, and does not ask again what you are connecting to — you said so on
   * the previous screen, and offering seven ways to contradict yourself is not a choice.
   */
  await page.getByTestId('new-connection').click();
  await expect(page.getByRole('dialog', { name: 'Connect to SQL Server' })).toBeVisible();
  await expect(page.getByText('What are you connecting to?')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel' }).first().click();

  await page
    .getByTestId(/^choose-connection-/)
    .first()
    .click();

  await expect(page.getByRole('heading', { name: 'Choose data' })).toBeVisible({ timeout: 60_000 });
  // Grouped by schema, because a database with one schema is a test fixture and not a customer.
  await expect(page.getByText('config', { exact: true })).toBeVisible();
  await expect(page.getByText('dbo', { exact: true })).toBeVisible();

  // Searching narrows it, which is the only way a list of hundreds is usable.
  await page.getByTestId('table-search').fill('Customer');
  await expect(page.getByTestId('object-dbo.Customer')).toBeVisible();
  await expect(page.getByTestId('object-config.Region')).toHaveCount(0);
  await page.getByTestId('table-search').fill('');

  // The preview is the evidence that this is the right table, before it is added.
  await page.getByTestId('object-row-dbo.Customer').getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('object-preview')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('object-preview')).toContainText('rows');
  // Values, not just column names: this is what tells you it is the customer table and not the audit copy.
  await expect(page.getByTestId('object-preview')).toContainText('CustomerNumber');
  await expect(page.getByTestId('object-preview')).toContainText('Identified by');
  await page.getByRole('dialog', { name: 'dbo.Customer' }).getByLabel('Close').click();

  await page.getByTestId('object-dbo.Customer').check();
  await page.getByTestId('object-config.Region').check();
  await expect(page.getByTestId('confirm-add-dataset')).toHaveText('Add 2 datasets');
  await page.getByTestId('confirm-add-dataset').click();
  await page.getByTestId('add-dataset').waitFor({ timeout: 60_000 });

  // Two tables of the database, listed as two datasets — not one row called "Legacy SQL Server (Demo)".
  await expect(page.getByTestId('dataset-row')).toHaveCount(7);
  for (const table of ['dbo.Customer', 'config.Region']) {
    await expect(page.getByTestId('dataset-row').filter({ hasText: table })).toHaveCount(1);
  }
  // Nothing has counted them, and nothing pretends to have.
  await expect(page.getByTestId('dataset-row').filter({ hasText: 'dbo.Customer' })).toContainText(
    'Size not counted yet',
  );

  /*
   * --- connecting is not choosing ---------------------------------------------
   *
   * The integrity test. On the build before the reset, choosing SharePoint created a connection, nothing
   * was selected from it, and the product let it be added and analysed — so an authenticated connection
   * holding nothing looked exactly like a dataset, and the user met the consequence later as a failure.
   */
  await page.getByTestId('add-dataset').click();
  await page.getByTestId('connector-sharepoint').click();

  // The card said what this is before anybody started, and the step says it again.
  await expect(page.getByText('SharePoint is not certified')).toBeVisible();
  await expect(page.getByText(/Never run against a real SharePoint tenant/)).toBeVisible();
  await expect(page.getByText(/Connecting does not add any data/)).toBeVisible();

  await page.getByTestId('new-connection').click();

  /*
   * A demo workspace has no Microsoft token, so browsing cannot work — and the one thing that must not
   * happen is an empty list, which would read as "your tenant has no sites".
   */
  await expect(page.getByText(/Microsoft sign-in/)).toBeVisible({ timeout: 30_000 });

  // And nothing became a dataset by connecting.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(7);
});

test('a decision is recorded beside the evidence, never over it', async ({ page }) => {
  await signIn(page);
  await createProject(page, 'Decision Check');
  await addDataset(page, 'Customers.csv');
  await runAnalysis(page);

  // Adding a dataset lands on Datasets, where what you just added is. The verdict is on Overview.
  await page.getByRole('tab', { name: 'Overview' }).click();
  const before = Number(await page.getByTestId('readiness-score').textContent());
  await page.getByRole('tab', { name: /Findings/ }).click();

  const finding = page.getByTestId('finding').filter({ hasText: 'empty in every record' }).first();
  const evidenceBefore = await finding.textContent();
  await finding.getByRole('button', { name: 'Record a decision' }).click();
  await finding.getByLabel('Decision', { exact: true }).selectOption('NOT_APPLICABLE');

  await expect(finding.getByTestId('disposition-status')).toHaveText('Not applicable');
  // The engine's words are untouched: the decision sits beside the evidence rather than replacing it.
  expect(evidenceBefore).toContain('contains no value in any of the');
  await expect(finding).toContainText('contains no value in any of the');
  await expect(finding).toHaveAttribute('data-disposition', 'NOT_APPLICABLE');

  // And readiness improves, because the score answers "what is left to deal with".
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect
    .poll(async () => Number(await page.getByTestId('readiness-score').textContent()), { timeout: 20_000 })
    .toBeGreaterThan(before);
});

test('a dataset added after an analysis is picked up by the next one', async ({ page }) => {
  await signIn(page);
  await createProject(page, 'Re-analysis Check');
  await addDataset(page, 'Customers.csv');
  await runAnalysis(page);
  const firstRuns = (await assessment(page)).runs.length;

  await addDataset(page, 'Contacts.csv');
  await page.getByRole('tab', { name: /Datasets/ }).click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(2);

  await page.getByRole('tab', { name: 'Overview' }).click();
  // The button says what is left to do rather than offering to redo everything.
  await expect(page.getByTestId('analyse')).toHaveText(/Analyse 1 of 2/);
  await runAnalysis(page);

  const after = await assessment(page);
  expect(after.runs.length, 'a second run exists, so the lineage is answerable').toBeGreaterThan(firstRuns);
  expect(
    [...new Set(after.findings.map((f) => f.table))].length,
    'findings now span both datasets',
  ).toBeGreaterThan(1);
});
