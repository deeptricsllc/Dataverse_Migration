import { expect, test } from '@playwright/test';

/**
 * The analysis experience, as a first-time visitor meets it.
 *
 * Not screenshot trivia. Each case is one of the claims the workspace makes, and the one that matters most
 * is the negative: **no source, no target, anywhere in an analysis project.** That was the single most
 * visible contradiction in the old product — a banner asking which environment four spreadsheets were
 * being migrated into, above a screen about understanding them — and it is the kind of thing that creeps
 * back the moment a shared layout changes.
 */

const signIn = async (page: import('@playwright/test').Page) => {
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

/** Builds the worked example and waits for the analysis, which is queued rather than inline. */
const buildDemo = async (page: import('@playwright/test').Page) => {
  const projectId = await page.evaluate(async () => {
    const session = (await (await fetch('/api/auth/session')).json()) as { csrfToken: string };
    const res = await fetch('/api/demo/analysis-project', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: '{}',
    });
    return ((await res.json()) as { id: string }).id;
  });
  await expect
    .poll(
      async () =>
        page.evaluate(async (id) => {
          const runs = (await (await fetch(`/api/projects/${id}/analyses`)).json()) as { status: string }[];
          return runs.length > 0 && runs.every((r) => r.status === 'COMPLETED');
        }, projectId),
      { timeout: 120_000, message: 'the demo analysis should complete' },
    )
    .toBe(true);
  return projectId;
};

test('the first screen explains the three things the product does', async ({ page }) => {
  await signIn(page);
  await page.goto('/');

  for (const [kind, question] of [
    ['ANALYSIS', 'What is in my data'],
    ['MIGRATION', 'How do I safely move data'],
    ['COMPARISON', 'Did these two systems end up agreeing?'],
  ] as const) {
    const card = page.getByTestId(`workflow-${kind}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(question);
  }
});

test('creating an analysis project asks for a name and nothing about migration', async ({ page }) => {
  await signIn(page);
  await page.goto('/projects');
  await page.getByTestId('workflow-ANALYSIS').click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The whole point: no source, no target, no environment pickers.
  await expect(dialog).not.toContainText(/source/i);
  await expect(dialog).not.toContainText(/target/i);

  await dialog.getByLabel('Project name').fill('Customer Data Assessment');
  await dialog.getByRole('button', { name: 'Create project' }).click();

  // It lands in the analysis workspace rather than a generic project page.
  await expect(page).toHaveURL(/\/analysis\//);
  await expect(page.getByRole('heading', { name: 'Customer Data Assessment' })).toBeVisible();
});

test('a duplicate project name is refused in words a person can act on', async ({ page }) => {
  await signIn(page);
  await page.goto('/projects');

  const create = async (name: string) => {
    await page.getByTestId('workflow-ANALYSIS').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Project name').fill(name);
    await dialog.getByRole('button', { name: 'Create project' }).click();
  };

  await create('Quarterly Assessment');
  await expect(page).toHaveURL(/\/analysis\//);
  await page.goto('/projects');
  await create('Quarterly Assessment');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('A project named "Quarterly Assessment" already exists');
  // Never the constraint that produced it.
  await expect(dialog).not.toContainText('projects_org_active_name_unique');
  await expect(dialog).not.toContainText('duplicate key');
});

/**
 * One walk over a finished assessment, rather than four that each rebuild it.
 *
 * Each `buildDemo` is a sign-in, four CSV imports and four analyses, and `/api/auth/demo-login` is rate
 * limited to fifteen a minute on purpose — each one seeds a workspace and runs real work. Four separate
 * builds here pushed the whole suite over that ceiling and made *other* specs fail at their sign-in.
 */
test('the assessment can be read, taken apart and challenged', async ({ page }) => {
  await signIn(page);
  const projectId = await buildDemo(page);
  await page.goto(`/analysis/${projectId}`);

  // --- it leads with what was found ----------------------------------------
  const summary = page.getByTestId('executive-summary');
  await expect(summary).toContainText('1,420 records');
  await expect(summary).toContainText('No reliable record identifier');
  await expect(page.getByTestId('readiness-score')).toHaveText('72');
  await expect(page.getByTestId('readiness-band')).toHaveText('Needs attention');

  // --- and never in migration terms -----------------------------------------
  const main = page.getByRole('main');
  await expect(main).not.toContainText(/\bSOURCE\b/);
  await expect(main).not.toContainText(/\bTARGET\b/);
  await expect(page.getByRole('link', { name: 'Change Environments' })).toHaveCount(0);

  // --- readiness can be taken apart ------------------------------------------
  await expect(page.getByTestId('readiness')).toContainText('100 − 1 critical × 35');
  await page.getByRole('button', { name: /Identity & keys/ }).click();
  const identityFinding = page
    .getByTestId('finding')
    .filter({ hasText: 'No reliable record identifier' })
    .first();
  await expect(identityFinding).toBeVisible();

  // --- a finding answers the five questions, and its evidence is one click away
  await page.getByRole('tab', { name: /Findings/ }).click();
  const finding = page.getByTestId('finding').first();
  await expect(finding).toHaveAttribute('data-severity', 'CRITICAL');
  await expect(finding).toContainText('No reliable record identifier'); // what
  await expect(finding).toContainText('Contacts'); // where
  await expect(finding).toContainText('100% of records'); // how much
  await expect(finding).toContainText('Why it matters'); // why
  await expect(finding).toContainText('What to do'); // what next
  await finding.getByRole('button', { name: 'Evidence' }).click();
  await expect(finding).toContainText('If migrated as it is:');

  // --- and the list can be narrowed to what is worth acting on ---------------
  const all = await page.getByTestId('finding').count();
  expect(all).toBeGreaterThan(10);
  await page.getByRole('button', { name: /Critical\s*\d+/ }).click();
  await expect(page.getByTestId('finding')).toHaveCount(1);
  await page.getByRole('button', { name: `All ${all}` }).click();
  await page.getByPlaceholder('Column or table').fill('order_date');
  await expect(page.getByTestId('finding').first()).toContainText('order_date');

  // --- the datasets tab describes what is being analysed ---------------------
  await page.getByRole('tab', { name: /Datasets/ }).click();
  const dataset = page.getByTestId('dataset-card').first();
  await expect(dataset).toContainText('Legacy CRM extract');
  await expect(dataset).toContainText('Files');
  await expect(dataset).toContainText('4 tables');
});
