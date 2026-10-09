import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeXlsx } from '../server/src/lib/xlsx';

/**
 * The three enterprise capabilities, against a workbook whose defects are known by construction.
 *
 * Every number this asserts can be counted by hand from the generator below, which is the point:
 * a finding that says "12 values repeat" is worth nothing unless 12 values actually repeat. The
 * certified first-time-user journey is left alone and still runs; this is a second journey over
 * harder data.
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
    await page.waitForTimeout(250);
    const dir = `${CAPTURE_DIR}/${w.label}`;
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${String(step).padStart(2, '0')}-${name}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/*
 * What is in the file, stated once so the assertions below can quote it.
 *
 *  Customers  60 rows. customer_number repeats: rows 48-59 reuse the first twelve numbers, so there
 *             are 48 distinct values, 12 of them held twice, 24 records in a collision.
 *             credit_limit holds a written amount every fifth row: 12 of 60.
 *  Products   20 rows. product_code is unique and complete — a valid business key, and the parent
 *             the other sheets point at. price is written as money in all 20. active spells yes and
 *             no four different ways.
 *  Orders     90 rows. order_number is unique. product_code always exists in Products.
 *             ordered_on is an ISO date except every tenth row, which is not a date at all: 9 of 90.
 *  Contacts   40 rows. product_code is unknown on rows 0, 13, 26 and 39: four orphan records.
 */
const ORPHAN_CONTACT_ROWS = [0, 13, 26, 39];

function enterpriseWorkbook(): Buffer {
  const customers = Array.from({ length: 60 }, (_, i) => [
    i < 48 ? `CUST-${1000 + i}` : `CUST-${1000 + (i - 48)}`,
    `Customer ${i}`,
    i % 3 === 0 ? '' : `buyer${i}@example.test`,
    i % 5 === 0 ? `$1,${200 + i}.50` : `${1000 + i * 7}`,
  ]);
  const products = Array.from({ length: 20 }, (_, i) => [
    `PROD-${100 + i}`,
    `Product ${i}`,
    `$${1 + i},${100 + i}.50`,
    ['Yes', 'no', 'TRUE', 'y'][i % 4],
  ]);
  const orders = Array.from({ length: 90 }, (_, i) => [
    `ORD-${5000 + i}`,
    `PROD-${100 + (i % 20)}`,
    i % 10 === 0 ? 'not a date' : `2026-0${(i % 9) + 1}-15`,
    `${(i % 9) * 125}`,
  ]);
  const contacts = Array.from({ length: 40 }, (_, i) => [
    `CTC-${7000 + i}`,
    `Contact ${i}`,
    ORPHAN_CONTACT_ROWS.includes(i) ? `PROD-9${i}` : `PROD-${100 + (i % 20)}`,
  ]);
  return writeXlsx([
    {
      name: 'Customers',
      columns: [
        { header: 'customer_number' },
        { header: 'customer_name' },
        { header: 'email' },
        { header: 'credit_limit' },
      ],
      rows: customers,
    },
    {
      name: 'Products',
      columns: [
        { header: 'product_code' },
        { header: 'product_name' },
        { header: 'price' },
        { header: 'active' },
      ],
      rows: products,
    },
    {
      name: 'Orders',
      columns: [
        { header: 'order_number' },
        { header: 'product_code' },
        { header: 'ordered_on' },
        { header: 'line_total' },
      ],
      rows: orders,
    },
    {
      name: 'Contacts',
      columns: [{ header: 'contact_ref' }, { header: 'contact_name' }, { header: 'product_code' }],
      rows: contacts,
    },
  ]);
}

/** One row of the exported report, by the rule that produced it. */
type Row = Record<string, string>;
function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const header = rows[0].map((h) => h.replace(/^﻿/, ''));
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

test('an enterprise export is assessed for keys, conversions and relationships', async ({ page }) => {
  test.setTimeout(900_000);
  const tag = Date.now().toString(36).slice(-5);
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  await page.goto('/');
  await page.getByTestId('try-demo-primary').first().click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();

  if (process.env.EXPECTED_SHA) {
    const res = await page.request.get('/api/settings');
    expect(res.ok()).toBe(true);
    const settings = await res.json();
    expect(
      String(process.env.EXPECTED_SHA).startsWith(String(settings.build?.commit)),
      `deployment reports ${settings.build?.commit}`,
    ).toBe(true);
    console.warn(`[provenance] ${settings.build.branch}@${settings.build.commit}`);
  }

  await page.goto('/projects');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-kind').selectOption('ANALYSIS');
  await page.getByTestId('project-name').fill(`Enterprise assessment ${tag}`);
  await page.getByTestId('create-project').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  const projectId = page.url().split('/projects/')[1]!.split(/[?#]/)[0]!;
  await page.goto(`/analysis/${projectId}`);

  await page.getByTestId('add-dataset').click();
  await page.getByTestId('connector-excel').click();
  await page.getByTestId('dataset-file-input').setInputFiles({
    name: 'EnterpriseExport.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: enterpriseWorkbook(),
  });
  await page.getByTestId('dataset-preview').waitFor({ timeout: 120_000 });
  await shot(page, 'four-sheets-previewed');
  await page.getByTestId('confirm-add-dataset').click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(4, { timeout: 120_000 });

  await page.getByTestId('analyse').click();
  const main = page.getByRole('main');
  await expect(main).toContainText('Analysed', { timeout: 600_000 });
  await expect(main).not.toContainText('not analysed yet', { timeout: 600_000 });
  await expect(page.getByRole('button', { name: /Analysing/ })).toHaveCount(0, { timeout: 600_000 });
  await shot(page, 'four-datasets-analysed');

  await page.getByRole('tab', { name: /Findings/ }).click();
  await shot(page, 'findings-across-four-datasets');

  // --- the report, which is where the numbers can be checked exactly --------
  const exportLink = page.getByRole('link', { name: /Export findings/ });
  await expect(exportLink).toBeVisible();
  const res = await page.request.get((await exportLink.getAttribute('href'))!);
  expect(res.status()).toBe(200);
  const csv = await res.text();
  if (CAPTURE_DIR) {
    mkdirSync(CAPTURE_DIR, { recursive: true });
    writeFileSync(`${CAPTURE_DIR}/enterprise-findings.csv`, csv, 'utf8');
  }
  const rows = parseCsv(csv);
  const find = (title: RegExp, table?: string) =>
    rows.find((r) => title.test(r.Finding) && (table === undefined || r.Table === table));

  // 1. Duplicate business keys, with the three counts that are easy to confuse.
  const dup = find(/customer_number does not uniquely identify/i);
  expect(dup, 'the colliding key is reported').toBeTruthy();
  expect(dup!['Records affected'], '24 records are in a collision').toBe('24');
  const dupEvidence = dup!.Evidence;
  expect(dupEvidence).toContain('60 records examined');
  expect(dupEvidence).toContain('48 distinct values');
  expect(dupEvidence).toContain('12 values held by more than one record');
  expect(dupEvidence).toContain('24 records involved in a collision');

  // A clean key is reported as a key, and does not count against readiness.
  const goodKey = find(/order_number looks like a business key/i);
  expect(goodKey, 'a valid business key is identified').toBeTruthy();
  expect(goodKey!['Counts against readiness']).toBe('No');

  // 2. Conversion intelligence.
  const money = find(/credit_limit holds money written as text/i);
  expect(money, 'money as text in a mostly-numeric column').toBeTruthy();
  expect(money!['Records affected'], 'every fifth of sixty').toBe('12');
  expect(money!.Evidence).toContain('$1,200.50');
  expect(money!['What to do']).toMatch(/decimal/i);

  const booleans = find(/active writes yes and no/i);
  expect(booleans, 'four spellings of yes').toBeTruthy();
  expect(booleans!.Finding).toContain('4 different ways');

  // 3. Relationships, and the line between inferred and confirmed.
  const orphans = find(/product_code points at Products records that are not there/i, 'Contacts');
  expect(orphans, 'the broken references are found').toBeTruthy();
  expect(orphans!['Records affected'], `rows ${ORPHAN_CONTACT_ROWS.join(', ')}`).toBe(
    String(ORPHAN_CONTACT_ROWS.length),
  );
  expect(orphans!.Evidence).toMatch(/inferred from the data/i);

  const inferred = rows.find(
    (r) => /Orders\.product_code → Products\.product_code/.test(r.Finding) && /inferred/.test(r.Finding),
  );
  expect(inferred, 'the clean relationship is inferred, and said to be inferred').toBeTruthy();
  expect(inferred!.Evidence, 'never presented as a declared foreign key').toContain(
    'Not a declared foreign key',
  );
  expect(inferred!['Counts against readiness'], 'finding a relationship is not a defect').toBe('No');

  await page.getByRole('tab', { name: /Overview/ }).click();
  await shot(page, 'readiness-with-relationships-assessed');
  // Relationships can now be assessed, because there is more than one table to compare.
  await expect(main).toContainText('Relationships');

  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});
