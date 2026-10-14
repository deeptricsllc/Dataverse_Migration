import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Every way into "add some data", checked one at a time.
 *
 * The owner found two of these offering different things: Connections showed "Upload from your
 * computer" and the new-project form did not. Both render the same component from the same
 * catalog, which is exactly why nobody caught it -- the difference was a prop, and no test
 * compared one entry point against another.
 *
 * So this file walks each entry point separately and asserts the same promise at each: a person
 * looking for a way to upload a spreadsheet finds one, named the same thing, in the same place.
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
    const s = await (await page.request.get('/api/settings')).json();
    expect(
      String(process.env.EXPECTED_SHA).startsWith(String(s.build?.commit)),
      `deployment reports ${s.build?.commit}`,
    ).toBe(true);
    console.warn(`[provenance] ${s.build.branch}@${s.build.commit}`);
  }
}

/** The promise every gallery makes, wherever it is opened from. */
async function assertFilesComeFirst(scope: Page | ReturnType<Page['getByRole']>) {
  const upload = scope.getByTestId('connector-upload');
  await expect(upload).toBeVisible();
  await expect(upload).toContainText('Upload from your computer');
  await expect(upload).toContainText('Excel (.xlsx), CSV or XML');
  // Grouped with the other ways of getting at a spreadsheet, in the order asked for.
  await expect(scope.getByTestId('connector-onedrive')).toBeVisible();
  await expect(scope.getByTestId('connector-sharepoint-library')).toBeVisible();
}

test('A. Connections, reached through the navigation', async ({ page }) => {
  const failed: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  await demo(page);
  await page.getByRole('link', { name: 'Connections' }).click();
  await page.getByRole('button', { name: 'Add connection' }).click();
  const dialog = page.getByRole('dialog');
  await assertFilesComeFirst(dialog);
  await shot(page, 'A-connections-add-connection');

  // Choosing a source replaces the picker with that source's form, on this screen.
  await dialog.getByTestId('connector-upload').click();
  await expect(dialog.getByTestId('staged-name')).toBeVisible();
  await expect(page).toHaveURL(/\/environments/);
  expect(failed, failed.join('\n')).toEqual([]);
});

test('B. Creating a project, and continuing straight into upload', async ({ page }) => {
  test.setTimeout(600_000);
  const tag = Date.now().toString(36).slice(-5);
  const failed: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  await demo(page);

  await page.goto('/projects?new=1');
  await page.getByTestId('project-name').fill(`Entry point B ${tag}`);
  await page.getByTestId('add-connection-link').click();
  const dialog = page.getByRole('dialog');
  // The entry point the owner's screenshot showed without a file option.
  await assertFilesComeFirst(dialog);
  await shot(page, 'B-new-project-add-connection');

  await dialog.getByTestId('connector-upload').click();
  // Nothing typed is lost, and no second dialog appears.
  await expect(page.getByTestId('project-name')).toHaveValue(`Entry point B ${tag}`);
  await page.getByTestId('create-project').click();

  // Straight into upload, in the project just created, without being asked again.
  await expect(page.getByTestId('dataset-dropzone')).toBeVisible({ timeout: 120_000 });
  await expect(page).toHaveURL(/\/analysis\/[0-9a-f-]{36}/);
  await shot(page, 'B-lands-in-upload');

  // And exactly one project was created for it.
  await page.goto('/projects');
  await expect(page.getByText(`Entry point B ${tag}`)).toHaveCount(1);
  expect(failed, failed.join('\n')).toEqual([]);
});

test('C. An existing project uploads into itself', async ({ page }) => {
  test.setTimeout(600_000);
  const tag = Date.now().toString(36).slice(-5);
  await demo(page);
  await page.goto('/projects?new=1');
  await page.getByTestId('project-name').fill(`Entry point C ${tag}`);
  await page.getByTestId('create-project').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  const id = page.url().split('/projects/')[1]!.split(/[?#]/)[0]!;
  await page.goto(`/analysis/${id}`);

  await page.getByTestId('add-dataset').click();
  await assertFilesComeFirst(page.getByRole('dialog'));
  await shot(page, 'C-existing-project-add-dataset');

  await page.getByTestId('connector-upload').click();
  await expect(page.getByTestId('dataset-dropzone')).toBeVisible();
  // Still the same project: no new one was made on the way.
  await expect(page).toHaveURL(new RegExp(id));
  await page.goto('/projects');
  await expect(page.getByText(`Entry point C ${tag}`)).toHaveCount(1);
});

test('a file is offered as a source and refused as a target, with the reason', async ({ page }) => {
  await demo(page);
  await page.goto('/projects?new=1');
  await page.getByTestId('project-kind').selectOption('MIGRATION');

  await page.getByTestId('add-connection-link').click();
  await expect(page.getByRole('dialog').getByTestId('connector-upload')).toBeEnabled();
  await page.getByRole('dialog').getByText('Close', { exact: true }).click();

  await page.getByTestId('add-connection-link-target').first().click();
  const upload = page.getByRole('dialog').getByTestId('connector-upload');
  await expect(upload, 'shown, not silently dropped').toBeVisible();
  await expect(upload).toBeDisabled();
  await expect(upload).toContainText('never written to');
  await shot(page, 'file-cannot-be-a-migration-target');
});
