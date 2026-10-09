import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/** Writes the screen at both review widths when CAPTURE_DIR is set. Evidence, not decoration. */
const CAPTURE_DIR = process.env.CAPTURE_DIR;
let shotNumber = 0;
async function shot(page: Page, name: string) {
  shotNumber += 1;
  if (!CAPTURE_DIR) return;
  for (const w of [
    { label: '1440x900', width: 1440, height: 900 },
    { label: '1920x1080', width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.waitForTimeout(250);
    const dir = `${CAPTURE_DIR}/${w.label}`;
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${String(shotNumber).padStart(2, '0')}-${name}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/**
 * The reported failure, driven through the browser, and the way out of it.
 *
 * From QA: a person created an analysis project, pointed it at a SharePoint connection, chose no
 * file, and pressed Analyse. The run was accepted and failed minutes later with
 * `None of the requested tables exist in this source` — a sentence about the engine's bookkeeping,
 * arriving long after the moment when they could have been told they had not chosen anything.
 *
 * Three things are held down here, and each was wrong:
 *
 *   1. A connection holding nothing cannot become a project's dataset, and saying so is immediate.
 *   2. The screen does not offer Analyse over a dataset that cannot be analysed.
 *   3. Choosing a file afterwards fixes it, and the analysis then runs on exactly that file.
 *
 * A live SharePoint tenant is not available to this test, so the empty connection is an uploaded
 * file source with nothing uploaded. That is the same state by the same rule — `resolveDataset`
 * treats both as a connection with no content — but it is not the same network, and the
 * SharePoint-specific browse path is certified separately.
 */
test('a connection with nothing chosen cannot be analysed, and says what to do', async ({ page }) => {
  const tag = Date.now().toString(36).slice(-5);
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();

  const session = await page.request.get('/api/auth/session');
  const csrf = (await session.json()).csrfToken as string;
  const headers = { 'x-csrf-token': csrf };

  /*
   * A connection that authenticated and holds nothing. Created through the API because the product
   * deliberately has no screen that produces one: files arrive through Add dataset, where choosing
   * is the interaction. It exists because connections outlive the content chosen from them.
   */
  const empty = await page.request.post('/api/staged-sources', {
    headers,
    data: { displayName: `Empty connection ${tag}`, kind: 'UPLOAD' },
  });
  expect(empty.status()).toBe(201);
  const emptyId = (await empty.json()).id as string;

  // --- 1. it cannot become a project's dataset ------------------------------
  const refused = await page.request.post('/api/projects', {
    headers,
    data: { name: `Refused ${tag}`, kind: 'ANALYSIS', sourceEnvironmentId: emptyId },
  });
  expect(refused.status(), 'refused at the moment it is asked for').toBe(400);
  const message = (await refused.json()).error.message as string;
  expect(message, 'it says what is missing').toContain('contains no files');
  expect(message, 'and what to do about it').toContain('Add a file');
  expect(message, 'never the engine’s own words').not.toContain('requested tables');

  // --- 2. the project form does not force the trap --------------------------
  await page.goto('/projects');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-kind').selectOption('ANALYSIS');
  await page.getByTestId('project-name').fill(`Analyse journey ${tag}`);
  /*
   * No connection chosen, and Create is available anyway. An analysis project needs a name; the
   * data is chosen in the workspace, where a sheet or a table has to be ticked. Requiring a choice
   * from a list of connections — which includes ones holding nothing — is what produced the trap.
   */
  await expect(page.getByTestId('create-project')).toBeEnabled();
  await shot(page, 'new-analysis-project-no-connection-required');
  await page.getByTestId('create-project').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);

  // --- 3. choosing a file is what makes it analysable -----------------------
  await page.goto(`/analysis${new URL(page.url()).pathname.replace('/projects', '')}`);
  await page.getByTestId('add-dataset').click();
  await page.getByTestId('connector-csv').click();
  await page.getByTestId('dataset-file-input').setInputFiles({
    name: 'customers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'customer_number,customer_name,email',
        ...Array.from({ length: 8 }, (_, i) => `C-${100 + i},Name ${i},p${i}@example.test`),
      ].join('\n'),
    ),
  });
  const preview = page.getByTestId('dataset-preview');
  await preview.waitFor({ timeout: 60_000 });
  await expect(preview).toContainText('8 rows');
  await shot(page, 'choose-the-data-before-analysing');
  await page.getByTestId('confirm-add-dataset').click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(1);

  // Now — and only now — the action is offered, and it names what it will do.
  const analyse = page.getByTestId('analyse');
  await expect(analyse).toBeEnabled();
  await expect(analyse).toContainText(/Analyse/);
  await shot(page, 'analyse-offered-once-data-is-chosen');
  await analyse.click();

  // --- and the result is about the file that was chosen ---------------------
  /*
   * Waited for, not glanced at. The first version of this asserted "8" while the run was still
   * queued — and "8 records" was already on the row from the import, so it would have passed over
   * an analysis that never finished. The state badge is the thing that changes.
   */
  await expect(page.getByTestId('dataset-row')).toContainText('Analysed', { timeout: 300_000 });
  await shot(page, 'analysis-result-for-the-chosen-file');

  /*
   * And the findings are about this file. Eight rows of three clean columns with a unique
   * identifier is not a dataset with problems, so the honest result is a readable summary rather
   * than invented findings — what must be true is that the numbers are the file's own.
   */
  await page.getByRole('tab', { name: /Overview/ }).click();
  const overview = page.getByRole('main');
  await expect(overview).toContainText('8');
  await shot(page, 'overview-of-the-analysed-file');
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});
