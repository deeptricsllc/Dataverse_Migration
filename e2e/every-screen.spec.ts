import { expect, test, type Page } from '@playwright/test';

/**
 * Every screen, visited.
 *
 * Not a feature test — a launch test. It exists because the fastest way to embarrass yourself in a
 * demo is a screen nobody opened since the last refactor: a crash, an unhandled fetch, a stuck spinner, or
 * an error card where an empty state belongs. This walks the whole navigation surface, including the
 * detail pages that only exist once something has been created, and fails on a console error anywhere.
 */

/** Screens reachable straight from the navigation, with something that proves each rendered. */
const TOP_LEVEL: { path: string; proof: RegExp }[] = [
  { path: '/', proof: /Welcome, Demo/ },
  { path: '/projects', proof: /^Projects$/ },
  { path: '/environments', proof: /Connections/ },
  { path: '/compare', proof: /Schema comparison/ },
  { path: '/users', proof: /User mapping/ },
  { path: '/migration', proof: /Migration plans/ },
  { path: '/validation', proof: /Validation/ },
  { path: '/runs', proof: /Runs/ },
  { path: '/diagnostics', proof: /Microsoft connection checks/ },
  { path: '/settings', proof: /Settings/ },
];

test('every screen renders without a console error or an error card', async ({ page }) => {
  const problems: string[] = [];
  let current = '(startup)';
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`${current}: console — ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`${current}: page error — ${err.message}`));
  page.on('requestfailed', (request) => {
    // A cancelled navigation request is not a failure worth reporting.
    const failure = request.failure()?.errorText ?? '';
    if (!/ERR_ABORTED/.test(failure)) problems.push(`${current}: request failed — ${request.url()}`);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (!url.includes('/api/')) return;
    // 401 before sign-in is expected; anything else in the 400s or 500s is not.
    if (response.status() >= 400 && response.status() !== 401) {
      problems.push(`${current}: ${response.status()} from ${url.replace(/^.*\/api\//, 'api/')}`);
    }
  });

  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();

  // Connections have to be discovered before several screens have anything to show.
  current = '/environments (discover)';
  await page.goto('/environments');
  await expect(page.getByTestId('env-card-DeepTrics QA')).toBeVisible({ timeout: 60_000 });

  for (const screen of TOP_LEVEL) {
    current = screen.path;
    await page.goto(screen.path);
    await expect(page.getByText(screen.proof).first()).toBeVisible({ timeout: 30_000 });
    await assertNoStuckState(page, screen.path, problems);
  }

  // --- the detail screens, which only exist once something has been created ---------------------
  current = 'create project';
  await page.goto('/projects?new=1');
  await page.getByTestId('project-kind').selectOption('ANALYSIS');
  await page.getByTestId('project-name').fill('Launch review');
  await page.getByLabel('Source').selectOption({ label: 'Legacy SQL Server (Demo)' });
  await page.getByTestId('create-project').click();
  await expect(page.getByRole('heading', { name: 'Launch review' })).toBeVisible();
  const projectUrl = page.url();

  current = 'run an analysis';
  await page.getByTestId('new-analysis').click();
  await page.getByRole('checkbox', { name: 'Customer' }).check();
  await page.getByTestId('start-analysis').click();
  await expect(page.getByTestId('analysis-tables')).toBeVisible({ timeout: 180_000 });
  const analysisUrl = page.url();

  current = 'analysis findings tab';
  await page.getByRole('tab', { name: /Findings/ }).click();
  await expect(page.getByTestId('analysis-findings')).toBeVisible();

  current = 'analysis columns drill-down';
  await page.getByRole('tab', { name: /Tables/ }).click();
  await page
    .getByTestId('analysis-tables')
    .getByRole('row')
    .filter({ hasText: 'dbo.Customer' })
    .first()
    .click();
  await expect(page.getByTestId('analysis-columns')).toBeVisible();

  current = 'back to the project';
  await page.goto(projectUrl);
  await assertNoStuckState(page, 'project', problems);

  current = 'reload the analysis directly';
  await page.goto(analysisUrl);
  await expect(page.getByTestId('analysis-tables')).toBeVisible({ timeout: 60_000 });

  // --- a migration project and a plan, so the plan screens are covered too ----------------------
  current = 'create migration project';
  await page.goto('/projects?new=1');
  await page.getByTestId('project-kind').selectOption('MIGRATION');
  await page.getByTestId('project-name').fill('Launch migration');
  await page.getByLabel('Source').selectOption({ label: 'Legacy SQL Server (Demo)' });
  await page.getByLabel('Target').selectOption({ label: 'DeepTrics QA' });
  await page.getByLabel('Based on analysis').selectOption({ label: 'Launch review' });
  await page.getByTestId('create-project').click();
  await expect(page.getByRole('heading', { name: 'Launch migration' })).toBeVisible();
  await assertNoStuckState(page, 'migration project', problems);

  // Every step of the plan editor, since each is a separate screen in practice.
  current = 'create a plan';
  await page.goto('/environments');
  await setWorkspace(page, 'Legacy SQL Server (Demo)', 'DeepTrics QA');
  await page.goto('/migration/new');
  await expect(page.getByRole('heading', { name: 'Select tables to migrate' })).toBeVisible({
    timeout: 60_000,
  });
  await assertNoStuckState(page, '/migration/new', problems);
  await expect(page.getByTestId('table-row-dbo.Customer')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('table-row-dbo.Customer').getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /Generate migration plan/ }).click();
  await expect(page).toHaveURL(/\/migration\/plans\//, { timeout: 60_000 });

  for (const step of ['tables', 'dependencies', 'mapping', 'review'] as const) {
    current = `plan step ${step}`;
    const url = page.url();
    if (!url.includes('/migration/plans/')) break;
    await page.goto(url.replace(/\?.*$/, '') + `?step=${step}`);
    await assertNoStuckState(page, `plan ${step}`, problems);
  }

  expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
});

/** No error card, and nothing still loading after it has had time to finish. */
async function assertNoStuckState(page: Page, where: string, problems: string[]): Promise<void> {
  await page.waitForTimeout(600);
  const errors = page.getByText(/Something went wrong|Request failed|Unexpected error/i);
  if (await errors.count()) {
    problems.push(`${where}: an error card is visible — ${(await errors.first().innerText()).slice(0, 200)}`);
  }
  const spinners = page.getByText(/^Loading…$/);
  if (await spinners.count()) {
    problems.push(`${where}: still loading after the page settled`);
  }
}

/**
 * The source and target the older screens read from.
 *
 * Waits for each selection to take effect rather than firing and hoping: the buttons only appear once
 * the connection cards have loaded, and the choice is saved through a request.
 */
async function setWorkspace(page: Page, source: string, target: string): Promise<void> {
  const sourceCard = page.getByTestId(`env-card-${source}`);
  const targetCard = page.getByTestId(`env-card-${target}`);
  await expect(sourceCard).toBeVisible({ timeout: 60_000 });
  await expect(targetCard).toBeVisible({ timeout: 60_000 });

  const setSource = sourceCard.getByRole('button', { name: 'Set as source' });
  if (await setSource.count()) await setSource.click();
  await expect(sourceCard.getByRole('button', { name: 'Source', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const setTarget = targetCard.getByRole('button', { name: 'Set as target' });
  if (await setTarget.count()) await setTarget.click();
  await expect(targetCard.getByRole('button', { name: 'Target', exact: true })).toBeVisible({
    timeout: 30_000,
  });
}
