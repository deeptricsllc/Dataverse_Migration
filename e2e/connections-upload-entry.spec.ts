import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * The entry point the owner went looking for, reached the way the owner reaches it.
 *
 * Every other spec navigates to `/environments` with `page.goto`. That proves the page renders;
 * it does not prove a person can get there, and the complaint was never "the component is wrong",
 * it was "I cannot find this". So this one signs in, clicks Connections in the navigation, clicks
 * Add connection, and asserts what is on the screen.
 *
 * It fails against any build before the source gallery existed, because `connector-upload` is not
 * in those bundles at all.
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
    await page.waitForTimeout(300);
    const dir = `${CAPTURE_DIR}/${w.label}`;
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${String(step).padStart(2, '0')}-${name}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function signIn(page: Page) {
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

test('a person clicking Connections then Add connection is offered a local file', async ({ page }) => {
  const failed: string[] = [];
  const errors: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await signIn(page);

  // Navigation, not a URL. This is the path the complaint describes.
  await page.getByRole('link', { name: 'Connections' }).click();
  await expect(page).toHaveURL(/\/environments/);
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
  await shot(page, 'connections-page');

  await page.getByRole('button', { name: 'Add connection' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  /*
   * The assertion the owner's report reduces to: is it on the screen, in words they were looking
   * for, in the group they would look in?
   */
  const upload = dialog.getByTestId('connector-upload');
  await expect(upload).toBeVisible();
  await expect(upload).toContainText('Upload from your computer');
  await expect(upload).toContainText('Excel (.xlsx), CSV or XML');
  await expect(dialog).toContainText('Files');
  // Grouped with files, still reached over the network: not badged as local.
  await expect(dialog.getByTestId('connector-onedrive')).toContainText('Not live verified');

  // The grouping, as asked for: files together, whatever they are stored in.
  await expect(dialog.getByTestId('connector-onedrive')).toBeVisible();
  await expect(dialog.getByTestId('connector-sharepoint-library')).toBeVisible();
  await expect(dialog.getByTestId('connector-sqlserver')).toBeVisible();
  await expect(dialog.getByTestId('connector-dataverse')).toBeVisible();
  await expect(dialog.getByTestId('connector-sharepoint-lists')).toBeVisible();
  await shot(page, 'add-connection-upload-visible');

  /*
   * And it stays here.
   *
   * This used to assert that choosing a local file navigated to the new-project screen, on the
   * reasoning that files live in projects. The owner reported it as a defect and was right: the
   * dialog asked what they were connecting to, they answered, and the product threw the answer away
   * and opened a form about something else. A file source is a thing the connections screen can
   * make, so choosing the card leads to making one.
   */
  await upload.click();
  await expect(dialog.getByTestId('staged-name')).toBeVisible();
  await expect(page).toHaveURL(/\/environments/);
  await shot(page, 'upload-stays-on-connections');

  expect(failed, failed.join('\n')).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the same entry point works at 390px', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/environments');
  await page.getByRole('button', { name: 'Add connection' }).click();
  const dialog = page.getByRole('dialog');
  const upload = dialog.getByTestId('connector-upload');
  await expect(upload).toBeVisible();
  // Visible without hunting: inside the viewport, not below a fold of database cards.
  const box = await upload.boundingBox();
  expect(box, 'the upload card has a position').not.toBeNull();
  expect(box!.y, 'it is in the first screenful').toBeLessThan(844);
  const overhang = Number(
    await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'),
  );
  expect(overhang, 'no sideways scrolling').toBeLessThanOrEqual(1);
  await shot(page, 'add-connection-on-a-phone');
});
