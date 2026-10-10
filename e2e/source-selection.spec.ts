import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { writeXlsx } from '../server/src/lib/xlsx';

/**
 * What a person sees when they go looking for a way to load their own data.
 *
 * These assert visible behaviour rather than endpoints, because the problem they exist for was
 * never an endpoint: uploading a spreadsheet worked perfectly well and the screen a person opened
 * to do it offered seven databases and no files, so they concluded the product could not.
 */

const CAPTURE_DIR = process.env.CAPTURE_DIR;
let step = 0;
async function shot(page: Page, name: string) {
  step += 1;
  if (!CAPTURE_DIR) return;
  for (const w of [
    { label: '1440x900', width: 1440, height: 900 },
    { label: '390x844', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.waitForTimeout(250);
    const dir = `${CAPTURE_DIR}/${w.label}`;
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${String(step).padStart(2, '0')}-${name}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function demo(page: Page) {
  await page.goto('/');
  await page.getByTestId('try-demo-primary').first().click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();
  if (process.env.EXPECTED_SHA) {
    const res = await page.request.get('/api/settings');
    const settings = await res.json();
    expect(
      String(process.env.EXPECTED_SHA).startsWith(String(settings.build?.commit)),
      `deployment reports ${settings.build?.commit}`,
    ).toBe(true);
    console.warn(`[provenance] ${settings.build.branch}@${settings.build.commit}`);
  }
}

function workbook(sheets: string[]): Buffer {
  return writeXlsx(
    sheets.map((name, s) => ({
      name,
      columns: [{ header: 'code' }, { header: 'label' }],
      rows: Array.from({ length: 6 }, (_, i) => [`${name}-${s}${i}`, `Row ${i}`]),
    })),
  );
}

test('the connections screen offers files, grouped with everything else it can read', async ({ page }) => {
  await demo(page);
  await page.goto('/environments');
  await page.getByTestId('add-connection').first().click();

  const dialog = page.getByRole('dialog');
  // The thing the owner went looking for and could not find.
  const upload = dialog.getByTestId('connector-upload');
  await expect(upload, 'files are offered on the connections screen').toBeVisible();
  await expect(upload).toContainText('Upload from your computer');
  await expect(upload).toContainText('.xlsx');

  // Grouped, rather than a flat list of names.
  await expect(dialog).toContainText('Files');
  await expect(dialog).toContainText('Databases');
  await expect(dialog).toContainText('Business applications');

  // Status is on the card, so nobody plans around a simulator.
  // Four categories, each meaning something different and each read from the evidence matrix.
  await expect(dialog.getByTestId('connector-dataverse')).toContainText('Simulated');
  await expect(
    dialog.getByTestId('connector-azuresql'),
    'built but never run live is not the same claim as simulated',
  ).toContainText('Not live verified');
  await expect(dialog.getByTestId('connector-sqlserver')).toContainText('Live verified');
  await expect(dialog.getByTestId('connector-upload')).toContainText('Local file');
  await expect(
    dialog.getByTestId('connector-postgres'),
    'a connector with real conformance evidence is not labelled as simulated',
  ).toContainText('Live verified');
  await shot(page, 'add-connection-source-gallery');

  // And it leads somewhere, rather than explaining where to go.
  await upload.click();
  await page.waitForURL(/\/projects\?new=1/);
  await expect(page.getByTestId('project-name')).toBeVisible();
  await shot(page, 'upload-card-opens-new-project');
});

test('a spreadsheet can be uploaded, previewed and analysed without any connection', async ({ page }) => {
  test.setTimeout(600_000);
  const tag = Date.now().toString(36).slice(-5);
  const failed: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });

  await demo(page);
  await page.goto('/projects?new=1');
  await page.getByTestId('project-name').fill(`Upload only ${tag}`);
  await page.getByTestId('create-project').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  const projectId = page.url().split('/projects/')[1]!.split(/[?#]/)[0]!;
  await page.goto(`/analysis/${projectId}`);

  await page.getByTestId('add-dataset').click();
  await page.getByTestId('connector-excel').click();

  // --- a file the reader cannot open is refused before it is sent ----------
  await page.getByTestId('dataset-file-input').setInputFiles({
    name: 'legacy.xls',
    mimeType: 'application/vnd.ms-excel',
    buffer: Buffer.from('not really a workbook'),
  });
  const rejected = page.getByTestId('upload-rejected');
  await expect(rejected, 'a format that was advertised but never supported').toBeVisible();
  await expect(rejected).toContainText('.xls format is not supported');
  await expect(rejected).toContainText('save it as .xlsx');
  await shot(page, 'legacy-xls-refused-with-a-way-out');

  // --- two files, reviewed one at a time -----------------------------------
  await page.getByTestId('dataset-file-input').setInputFiles([
    { name: 'first.xlsx', mimeType: XLSX_MIME, buffer: workbook(['Alpha']) },
    { name: 'second.xlsx', mimeType: XLSX_MIME, buffer: workbook(['Beta']) },
  ]);
  const queue = page.getByTestId('upload-queue');
  await expect(queue, 'several files can be chosen at once').toBeVisible();
  await expect(queue).toContainText('File 1 of 2');
  await expect(page.getByTestId('dataset-preview')).toBeVisible({ timeout: 120_000 });
  await shot(page, 'two-files-queued-first-previewed');

  await page.getByTestId('confirm-add-dataset').click();
  await expect(queue).toContainText('File 2 of 2', { timeout: 120_000 });
  await expect(page.getByTestId('dataset-preview')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('confirm-add-dataset').click();

  await expect(page.getByTestId('dataset-row')).toHaveCount(2, { timeout: 120_000 });
  await shot(page, 'both-files-became-datasets');

  // --- and the whole point: analysis, with no connection configured --------
  await page.getByTestId('analyse').click();
  const main = page.getByRole('main');
  await expect(main).toContainText('Analyzed', { timeout: 600_000 });
  await expect(main).not.toContainText('not analyzed yet', { timeout: 600_000 });

  const exportLink = page.getByRole('link', { name: /Export findings/ });
  await expect(exportLink).toBeVisible();
  const res = await page.request.get((await exportLink.getAttribute('href'))!);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('Why it matters');
  await shot(page, 'analysed-and-exportable-from-files-alone');

  expect(failed, failed.join('\n')).toEqual([]);
});

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A project with one dataset already in it, so the next upload starts from an existing project. */
async function projectWithOneDataset(page: Page, tag: string): Promise<string> {
  await page.goto('/projects?new=1');
  await page.getByTestId('project-name').fill(`Existing project ${tag}`);
  await page.getByTestId('create-project').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  const id = page.url().split('/projects/')[1]!.split(/[?#]/)[0]!;
  await page.goto(`/analysis/${id}`);
  await page.getByTestId('add-dataset').click();
  await page.getByTestId('connector-csv').click();
  await page.getByTestId('dataset-file-input').setInputFiles({
    name: 'opening.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('code,label\nA,First\nB,Second\n'),
  });
  await page.getByTestId('dataset-preview').waitFor({ timeout: 120_000 });
  await page.getByTestId('confirm-add-dataset').click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(1, { timeout: 120_000 });
  return id;
}

test('CSV and XML upload through the browser, each read as its own shape', async ({ page }) => {
  test.setTimeout(600_000);
  const tag = Date.now().toString(36).slice(-5);
  await demo(page);
  const projectId = await projectWithOneDataset(page, tag);

  /*
   * The second upload starts from the project that is already open.
   * Nobody should have to create a project to add a file to the project they are looking at.
   */
  await page.getByRole('button', { name: 'Add another dataset' }).click();
  await page.getByTestId('connector-xml').click();
  await page.getByTestId('dataset-file-input').setInputFiles({
    name: 'orders.xml',
    mimeType: 'application/xml',
    buffer: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<orders>
  <order ref="ORD-1"><customer>C1</customer><total>10.50</total></order>
  <order ref="ORD-2"><customer>C2</customer><total>20.00</total></order>
  <order ref="ORD-3"><customer>C1</customer><total>30.25</total></order>
</orders>`,
    ),
  });
  const preview = page.getByTestId('dataset-preview');
  await preview.waitFor({ timeout: 120_000 });
  // The reader found records, and the attributes and child elements became columns.
  await expect(preview).toContainText('3');
  await expect(preview).toContainText(/ref|customer|total/);
  await shot(page, 'xml-previewed-inside-an-existing-project');
  await page.getByTestId('confirm-add-dataset').click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(2, { timeout: 120_000 });

  await page.getByTestId('analyse').click();
  const main = page.getByRole('main');
  await expect(main).toContainText('Analyzed', { timeout: 600_000 });
  await expect(main).not.toContainText('not analyzed yet', { timeout: 600_000 });
  // Both files are in the one project, and neither needed a connection.
  await expect(main).toContainText('5 records');
  await shot(page, 'csv-and-xml-analysed-together');

  const exportLink = page.getByRole('link', { name: /Export findings/ });
  await expect(exportLink).toBeVisible();
  const res = await page.request.get((await exportLink.getAttribute('href'))!);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('Why it matters');
  void projectId;
});

test('a refused file does not end the attempt', async ({ page }) => {
  const tag = Date.now().toString(36).slice(-5);
  await demo(page);
  await page.goto('/projects?new=1');
  await page.getByTestId('project-name').fill(`Recovery ${tag}`);
  await page.getByTestId('create-project').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  const id = page.url().split('/projects/')[1]!.split(/[?#]/)[0]!;
  await page.goto(`/analysis/${id}`);
  await page.getByTestId('add-dataset').click();
  await page.getByTestId('connector-csv').click();

  await page.getByTestId('dataset-file-input').setInputFiles({
    name: 'holiday.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('not a spreadsheet'),
  });
  await expect(page.getByTestId('upload-rejected')).toContainText('cannot be read here');

  // The same control still works, and the refusal clears rather than lingering as a false alarm.
  await page.getByTestId('dataset-file-input').setInputFiles({
    name: 'recovered.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('code,label\nA,First\n'),
  });
  await expect(page.getByTestId('dataset-preview')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('upload-rejected')).toHaveCount(0);
  await shot(page, 'recovered-after-a-refused-file');
});

test('the connections list says which connections are simulated', async ({ page }) => {
  await demo(page);
  await page.goto('/environments');
  const main = page.getByRole('main');
  await expect(main).toContainText('Simulated');
  /*
   * The same claim on both screens. A card in the gallery that says Simulated and a connection in
   * the list that does not would be two answers to one question.
   */
  const dataverseCard = main.locator('article, li, div').filter({ hasText: 'Microsoft Dataverse' }).first();
  await expect(dataverseCard).toBeVisible();
  await shot(page, 'connections-list-shows-simulated');
});

test('the source gallery is usable by keyboard and on a phone', async ({ page }) => {
  await demo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/environments');
  await page.getByTestId('add-connection').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('connector-upload')).toBeVisible();

  // Cards are buttons, so they are reachable and operable without a mouse.
  const upload = dialog.getByTestId('connector-upload');
  await upload.focus();
  await expect(upload).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/projects\?new=1/);

  // No horizontal scrolling at phone width.
  const overhang = Number(
    await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'),
  );
  expect(overhang, 'the page does not scroll sideways on a phone').toBeLessThanOrEqual(1);
});
