import { expect, test } from '@playwright/test';

/**
 * Files are datasets, and Connections is for systems.
 *
 * This journey used to begin on the Connections page: create a connection, choose "CSV / Excel / XML
 * file", get a connection with nothing in it, then find the file picker on its card. That is an
 * implementation detail wearing the product's vocabulary — a spreadsheet on somebody's laptop is not
 * reusable authenticated access to a system, it is the data itself — and it is the single thing a
 * first-time user asked about most: "do I need to create a connection for this Excel file?"
 *
 * So this test now holds down both halves of the answer. Files go in through **Add dataset**, where XML
 * is read into real columns rather than a single column of markup. And Connections no longer offers a
 * file as something to connect to, nor shows an uploaded one as a system.
 */
test('a file is a dataset, and Connections is for systems', async ({ page }) => {
  const tag = Date.now().toString(36).slice(-5);
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();

  // --- Connections is about systems -----------------------------------------
  await page.goto('/environments');
  await expect(page.getByTestId('env-card-DeepTrics QA')).toBeVisible({ timeout: 60_000 });

  // The page says what it is for, and it is not a step of a migration.
  await expect(
    page.getByText(/Systems this demo workspace can reach|available to your organization/),
  ).toBeVisible();
  const main = page.getByRole('main');
  await expect(main).not.toContainText('Set as source');
  await expect(main).not.toContainText('Set as target');
  await expect(main).not.toContainText('File sources');

  // A connection's state is not "Connected" merely because a row exists: a simulated one says so.
  const qa = page.getByTestId('env-card-DeepTrics QA');
  await expect(qa).toContainText('Simulated');

  // And a file is not something you connect to.
  await page.getByTestId('add-connection').click();
  await expect(page.getByText('What are you connecting to?')).toBeVisible();
  await expect(page.getByTestId('connection-type-SQL_SERVER')).toBeVisible();
  await expect(page.getByTestId('connection-type-FILE')).toHaveCount(0);
  // No type chosen yet, so the dialog offers only a way out. The footer one, not the header's X.
  await page
    .getByRole('dialog', { name: 'Add connection' })
    .getByRole('button', { name: 'Close' })
    .last()
    .click();

  // --- what a connection can reach, without creating a project to find out ---
  await qa.scrollIntoViewIfNeeded();
  await page.getByTestId('connection-card-DeepTrics QA').getByTestId('browse-connection').click();
  await expect(page.getByTestId('connection-contents')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('dialog', { name: 'DeepTrics QA' }).getByRole('button', { name: 'Close' }).click();

  // --- a file goes in as a dataset ------------------------------------------
  await page.goto('/projects');
  await page.getByTestId('workflow-ANALYSIS').click();
  await page.getByLabel('Project name').fill(`What is in the extract ${tag}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/analysis\//);

  await page.getByTestId('add-dataset').click();
  await page.getByTestId('connector-xml').click();
  await page.getByTestId('dataset-file-input').setInputFiles({
    name: 'orders.xml',
    mimeType: 'application/xml',
    buffer: Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<orders>',
        '  <order ref="ORD-1"><customer>Acme Industries</customer><total>1250.75</total></order>',
        '  <order ref="ORD-2"><customer>Globex</customer><total>99</total></order>',
        '  <order ref="ORD-3"><customer>Initech</customer><total>480.10</total></order>',
        '</orders>',
      ].join('\n'),
    ),
  });

  // Real columns from the attribute and the child elements, rather than one column of markup.
  const preview = page.getByTestId('dataset-preview');
  await preview.waitFor({ timeout: 60_000 });
  await expect(preview).toContainText('3 rows');
  await expect(preview).toContainText('customer');
  await expect(preview).toContainText('total');
  await expect(preview).toContainText('ref looks like a possible record identifier');

  await page.getByTestId('confirm-add-dataset').click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(1);
  await expect(page.getByTestId('dataset-name')).toHaveText('orders');

  // And the upload did not create anything on the Connections page.
  await page.goto('/environments');
  await expect(page.getByTestId('env-card-DeepTrics QA')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('main')).not.toContainText('orders');

  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});
