import { expect, test } from '@playwright/test';

/**
 * A spreadsheet as a source, in the browser: created without a host or password, a CSV uploaded, the
 * inferred columns shown with their reasoning, and — the part that matters — never offered as a
 * migration target.
 */
test('file source: upload a CSV and analyse it', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();

  // 1. Add a file source. Choosing the kind removes the whole server form.
  await page.goto('/environments');
  await expect(page.getByTestId('env-card-DeepTrics QA')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('add-connection').click();
  await page.getByRole('radio', { name: /CSV \/ Excel \/ XML file/ }).check();
  await expect(page.getByText(/there is no host, port or password/)).toBeVisible();
  await expect(page.getByLabel('Server / host')).toHaveCount(0);
  await page.getByLabel('Name').fill('Customer extracts');
  await page.getByTestId('create-staged-source').click();

  // 1b. Creating the connection lands on the thing you now have to do. It used to close the
  // dialog and leave you at the top of the connections page, with the file picker in a section
  // below every other connection and nothing on screen suggesting it existed.
  await expect(page.getByText(/Connection created\. Choose the file to import/)).toBeVisible();
  await expect(page.getByTestId('staged-file')).toBeVisible();
  // And a file source is not also listed as an ordinary connection card with every row empty.
  await expect(page.getByTestId(`env-card-${'Customer extracts'}`)).toHaveCount(0);

  // 2. The card appears, saying it has nothing yet.
  const card = page.getByTestId(/^staged-source-/);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Nothing imported yet');

  // 3. Upload a CSV. `pending` in a numeric column is what keeps that column text.
  await page.getByTestId('staged-file').setInputFiles({
    name: 'customers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'customer_id,company_name,employees,signed_on,legacy_code',
        'C-001,Acme Industries,120,2024-03-01,',
        'C-002,Globex,4,2025-11-14,',
        'C-003,Initech,pending,2023-07-22,',
      ].join('\r\n'),
    ),
  });

  await expect(page.getByTestId('staged-import-result')).toContainText('3 row(s)');
  await expect(card).toContainText('customers');
  // A key-shaped, unique, always-present column identifies the row.
  await expect(card).toContainText('key: customer_id');

  // 4. The inferred columns, with the reasoning shown rather than hidden.
  await card.getByText(/^Columns \(5\)$/).click();
  await expect(card).toContainText('every value is a date');
  await expect(card).toContainText('mixed values, kept as text');
  await expect(card).toContainText('no values to infer from');

  // 4b. An XML export lands as a table too, imported into the same source.
  await page.getByTestId('staged-file').setInputFiles({
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
  await expect(page.getByTestId('staged-import-result')).toContainText('3 row(s)');
  // Real columns from the attribute and the elements, rather than one column of markup.
  await expect(card).toContainText('orders');
  await expect(card).toContainText('key: ref');

  // 5. It can be a source, and is never offered as a target. The action lives on the file source's
  // own card, which is the only card it has now.
  const fileCard = page.getByTestId(/^staged-source-/);
  await expect(fileCard.getByRole('button', { name: 'Set as source' })).toBeVisible();
  await expect(fileCard.getByRole('button', { name: /Set as target|^Target$/ })).toHaveCount(0);
  // Capabilities say so too, rather than the button merely being absent.
  await expect(fileCard).toContainText('CSV / Excel / XML file');

  // 6. Analyse it as an ordinary source.
  await page.goto('/projects');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-kind').selectOption('ANALYSIS');
  await page.getByTestId('project-name').fill('What is in the extract');
  await page.getByLabel('Source').selectOption({ label: 'Customer extracts' });
  await page.getByTestId('create-project').click();
  await page.getByTestId('new-analysis').click();
  await page.getByTestId('start-analysis').click();

  await expect(page.getByTestId('analysis-tables')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('These numbers are exact')).toBeVisible();
  const tables = page.getByTestId('analysis-tables');
  await expect(tables).toContainText('customers');
  // The column that is empty in every row is called out — the reason to analyse an extract at all.
  await expect(tables).toContainText('legacy_code');

  expect(consoleErrors).toEqual([]);
});
