import { expect, test, type Page } from '@playwright/test';

/**
 * Owner acceptance journey in DEMO MODE:
 * login → environments → source/target → verify → analyze → schema diff → select tables →
 * dependencies → mapping → plan review → execute → monitor → validate → report → reopen history.
 */
/**
 * A migration's two ends belong to the migration.
 *
 * This used to begin on Connections, marking one connection "the source" and another "the target" for the
 * whole application, and every later step read that global state. That is the old product model, and a
 * test that drives it keeps it alive: it would have gone on passing while the product said something the
 * architecture no longer meant.
 *
 * The project is created with its own two ends, and the plan is built inside it.
 */
const createMigrationProject = async (page: Page, name: string, source: string, target: string) => {
  await page.goto('/projects');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-kind').selectOption('MIGRATION');
  await page.getByTestId('project-name').fill(name);
  await page.getByLabel('Source').selectOption({ label: source });
  await page.getByLabel('Target').selectOption({ label: target });
  await page.getByTestId('create-project').click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  return page.url().split('/projects/')[1].split(/[?#]/)[0];
};

test('demo happy path: plan, migrate and validate', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  // 1. Login, the way a visitor actually arrives: the root is the public landing page until
  // somebody is signed in, and the demo starts from there.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Know exactly what a migration will do/ })).toBeVisible();
  await page.getByTestId('try-demo-primary').first().click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();
  await expect(page.getByText('DEMO MODE').first()).toBeVisible();

  // 2. Environments (auto-discovered on first visit)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Connections' }).click();
  const devCard = page.getByTestId('env-card-DeepTrics Development');
  const qaCard = page.getByTestId('env-card-DeepTrics QA');
  await expect(devCard).toBeVisible();
  await expect(qaCard).toBeVisible();
  await expect(page.getByTestId('env-card-DeepTrics UAT')).toBeVisible();

  // A connection that cannot be reached still says so plainly, on the connection itself.
  const prodCard = page.getByTestId('env-card-DeepTrics Production');
  await prodCard.getByRole('button', { name: 'Test connection' }).click();
  await expect(prodCard.getByText(/not a member of the organization/)).toBeVisible();

  // Connections carry no role: there is nothing here that makes one "the source".
  await expect(page.getByRole('button', { name: 'Set as source' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set as target' })).toHaveCount(0);

  // Testing a connection is a thing you do to a connection, which is why it stayed on this page.
  for (const card of [devCard, qaCard]) {
    const test = card.getByRole('button', { name: 'Test connection' });
    if (await test.count()) await test.click();
    await expect(card.getByText('Connected', { exact: true })).toBeVisible({ timeout: 60_000 });
  }

  // The migration owns its two ends.
  const projectId = await createMigrationProject(
    page,
    `Happy path ${Date.now()}`,
    'DeepTrics Development',
    'DeepTrics QA',
  );
  // The project owns its two ends. Asserted before going on, because a comparison with no sides shows an
  // empty state and the failure then points at the comparison rather than at the setup.
  const ends = await page.evaluate(async (id) => {
    const p = (await (await fetch(`/api/projects/${id}`)).json()) as {
      sourceEnvironment: { displayName: string } | null;
      targetEnvironment: { displayName: string } | null;
    };
    return {
      source: p.sourceEnvironment?.displayName ?? null,
      target: p.targetEnvironment?.displayName ?? null,
    };
  }, projectId);
  expect(ends).toEqual({ source: 'DeepTrics Development', target: 'DeepTrics QA' });

  await page.goto(`/compare?projectId=${projectId}`);

  // 3. Analyze & schema diff
  await expect(page).toHaveURL(/\/compare/);
  // Fresh environment shows "Analyze now"; one with an earlier comparison shows "Re-analyze".
  await clickEither(page, /^Analyze now$|^Re-analyze \(refresh metadata\)$/);
  // Starting a comparison navigates to its own URL. The project has to survive that, or every later
  // step asks the user which migration they meant.

  await expect(page.getByRole('button', { name: /Tables compared/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /Potentially incompatible/ })).toBeVisible();
  await page.getByTestId('diff-row-account').click();
  await expect(page.getByText('dtx_tier', { exact: true })).toBeVisible();
  await expect(page.getByText('Choice values 7 do not exist in target')).toBeVisible();
  await page.getByTestId('diff-row-product').click();
  await expect(page.getByText('String cannot be converted to Integer')).toBeVisible();

  // 4. Select tables (dependencies are shown, not auto-selected)
  await page.getByRole('button', { name: 'Continue: Select tables' }).click();
  await expect(page.getByRole('heading', { name: 'Select tables to migrate' })).toBeVisible();
  await selectTable(page, 'account');
  await expect(page.getByTestId('dependency-hint-account')).toContainText('Contact');
  await expect(page.getByTestId('dependency-hint-account')).toContainText('Region');
  for (const t of ['contact', 'dtx_region', 'dtx_office', 'dtx_applicationconfig', 'product'])
    await selectTable(page, t);
  await expect(page.getByTestId('dependency-hint-account')).toHaveCount(0);
  await page.getByRole('button', { name: /Generate migration plan/ }).click();

  // 5. Dependencies
  await expect(page.getByTestId('migration-order')).toBeVisible({ timeout: 60_000 });
  const order = await page.getByTestId('migration-order').innerText();
  expect(order.indexOf('Region')).toBeLessThan(order.indexOf('Office'));
  expect(order.indexOf('Account')).toBeLessThan(order.indexOf('Contact'));
  await expect(page.getByText(/Cycle \d: account ↔ contact/)).toBeVisible();

  // 6. Field mapping
  await page.getByRole('button', { name: 'Continue: Map fields' }).click();
  await page.getByRole('button', { name: /^Account/ }).click();
  await expect(page.getByTestId('mapping-accountnumber')).toBeVisible();
  await expect(page.getByTestId('mapping-dtx_tier')).toContainText('Unmapped');
  await expect(page.getByTestId('mapping-ownerid')).toContainText('Ignored');

  // 6b. User mapping and ownership/audit options
  /*
   * Reached as a step of this migration, not from global navigation. Matching people between two systems
   * is only meaningful once you know which two, so it is no longer a destination of its own.
   */
  await page.goto(`/users?projectId=${projectId}`);
  await clickEither(page, /^Load and match users$|^Refresh directories$/);
  await expect(page.getByTestId('principal-Priya Patel')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('principal-Priya Patel')).toContainText('entra object id');
  await expect(page.getByTestId('principal-Legacy Integration Account')).toContainText('Unmatched');
  // An identity that matches two target users is never mapped automatically. Against a deployment
  // where an earlier run already resolved it, the mapping is simply already manual, so this covers
  // both states rather than assuming a fresh database.
  const jordan = page.getByTestId('principal-Jordan Lee');
  await expect(jordan).toBeVisible();
  if (
    await jordan
      .getByTestId('ambiguous-candidates')
      .isVisible()
      .catch(() => false)
  ) {
    await expect(jordan).toContainText('Ambiguous');
    await expect(jordan.getByTestId('ambiguous-candidates')).toContainText('2 candidates');
    await jordan
      .getByRole('button', { name: /^Use Jordan Lee/ })
      .first()
      .click();
  }
  await expect(jordan).not.toContainText('Ambiguous');

  await page.getByRole('button', { name: 'Run check' }).click();
  await expect(page.getByText(/may act on behalf of other users/)).toBeVisible();
  await page.goBack();

  // 7. Review & execute
  await page.getByRole('button', { name: 'Continue: Review plan' }).click();
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  await expect(page.getByTestId('issue-WARNING').first()).toBeVisible();
  // Audit preservation and unresolved-user handling are explicit policies.
  await page.getByTestId('audit-policy-STANDARD').click();
  // STRICT is the default: the unmapped service account blocks the plan instead of being
  // silently replaced by the executing user.
  await expect(page.getByTestId('issue-BLOCKER').first()).toBeVisible();
  await expect(page.getByText(/records are blocked instead of being reassigned/)).toBeVisible();
  await page.getByTestId('user-policy-FALLBACK').click();
  await expect(page.getByText(/no fallback identity has been chosen/)).toBeVisible();
  await page.getByLabel('Fallback identity').selectOption({ index: 1 });
  await expect(page.getByTestId('issue-BLOCKER')).toHaveCount(0);

  // 7b. Preflight: the dry run says exactly what would happen, and writes nothing.
  await page.getByTestId('open-preflight').click();
  await page.getByTestId('run-preflight').click();
  await expect(page.getByRole('heading', { name: 'By table' })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Create', { exact: true }).first()).toBeVisible();
  await page.getByText('Create', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Records' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Export preflight CSV' })).toBeVisible();
  await page.goBack();

  // The two actions this step exists to reach stay on screen while the review is read: they used
  // to be at the bottom of a long page, so acting on the review meant scrolling past it.
  await page.mouse.wheel(0, -5000);
  await expect(page.getByTestId('execute-bar')).toBeInViewport();

  /*
   * Wait for the demo workspace to finish building itself.
   *
   * Signing in seeds the workspace by running two real migrations in the background, and the engine
   * refuses a second migration into a target another run still holds — correctly, because two concurrent
   * writers to one environment is the thing that guard exists to prevent. The test was racing the seed:
   * it passed whenever the seed finished first, which is a property of the machine rather than of the
   * product.
   */
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const runs = (await (await fetch('/api/runs')).json()) as { status: string }[];
          return runs.some((r) => r.status === 'QUEUED' || r.status === 'RUNNING');
        }),
      { timeout: 180_000, message: 'the demo workspace should finish seeding before a second migration' },
    )
    .toBe(false);

  await page.getByRole('button', { name: 'Execute migration' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm migration execution' });
  await expect(dialog.getByText('DeepTrics Development').first()).toBeVisible();
  await expect(dialog.getByText('DeepTrics QA').first()).toBeVisible();
  const runButton = dialog.getByRole('button', { name: 'Write data to DeepTrics QA' });
  await expect(runButton).toBeDisabled();
  await dialog.getByTestId('ack-warnings').check();
  const identityAck = dialog.getByTestId('ack-identity');
  if (await identityAck.isVisible().catch(() => false)) await identityAck.check();
  // QA is a sandbox, so the button that names the target is the confirmation. Typing the name is
  // reserved for production, where it is still required.
  await expect(dialog.getByTestId('confirm-target')).toHaveCount(0);
  await expect(dialog.getByText(/non-production environment, so the button below/)).toBeVisible();
  await runButton.click();

  // 8. Monitor
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByTestId('run-entity-account')).toBeVisible();
  await expect(page.getByText('Completed with errors').first()).toBeVisible({ timeout: 180_000 });
  /*
   * The result, not the progress bar. The live progress card stops once a run finishes — every line of it
   * is in the result card or in the tables tab by then — so what this asserts is the summary a reader
   * actually gets: the counts, in the first viewport.
   */
  await expect(page.getByTestId('run-counts')).toContainText('Attempted');
  await expect(page.getByTestId('run-result-reason')).toBeVisible();
  // The tab is named for what is in it: failures, warnings, or both.
  await page.getByRole('tab', { name: /Failures|Warnings/ }).click();
  await expect(page.getByTestId('run-error-row').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Export CSV' }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Rollback preview' }).click();
  await expect(page.getByText('Rollback execution: NOT YET SUPPORTED')).toBeVisible();

  // 9. Validate & report
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page).toHaveURL(/\/validation\//);
  await expect(page.getByRole('heading', { name: 'Results by table' })).toBeVisible({ timeout: 120_000 });

  // One verdict, not two badges that appear to contradict each other: "Completed" (the job) beside
  // "Fail" (the data) read as a bug in the report rather than a finding about the data.
  await expect(page.getByText('Completed', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/All checks passed|Passed with warnings|Checks failed/).first()).toBeVisible();

  // And the numbers are explained in words before the tiles, including why the target holds more
  // rows than the source.
  const verdict = page.getByTestId('validation-verdict');
  await expect(verdict).toBeVisible();
  await expect(verdict).toContainText(/record\(s\) were checked/);

  await page.getByTestId('validation-entity-account').click();
  await expect(page.getByText('Record existence')).toBeVisible();
  await page.getByRole('button', { name: 'Inspect differences for Account' }).click();
  await expect(page.getByTestId('difference-row').first()).toBeVisible();
  // Exports are available for the team to work from outside the app.
  const exportLink = page.getByRole('link', { name: 'Export differences' });
  await expect(exportLink).toBeVisible();
  const download = await Promise.all([page.waitForEvent('download'), exportLink.click()]).then((r) => r[0]);
  expect(download.suggestedFilename()).toMatch(/^validation-differences-.*\.csv$/);

  // 10. Reopen: history persists
  const reportUrl = page.url();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Validation report' })).toBeVisible();
  await page.goto('/runs');
  // At least this run: the suite can also run against an environment with earlier history.
  await expect(page.getByTestId('run-row').first()).toBeVisible();
  expect(await page.getByTestId('run-row').count()).toBeGreaterThanOrEqual(1);
  await page.getByRole('tab', { name: /Validation runs/ }).click();
  await expect(page.getByTestId('validation-row').first()).toBeVisible();
  await page.goto(reportUrl);
  await expect(page.getByTestId('validation-entity-account')).toBeVisible();

  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});

/** Clicks whichever of the alternative buttons the current state offers. */
async function clickEither(page: Page, name: RegExp) {
  const button = page.getByRole('button', { name });
  await expect(button.first()).toBeVisible();
  await button.first().click();
}

async function selectTable(page: Page, logicalName: string) {
  const row = page.getByTestId(`table-row-${logicalName}`);
  await row.getByRole('checkbox').check();
  await expect(row.getByRole('checkbox')).toBeChecked();
}

/**
 * Diagnostics are read-only: they must run without ever probing write permission.
 */
test('diagnostics report read-only checks without testing writes', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with demo account' }).click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Microsoft checks' })
    .click();
  await page.getByTestId('run-diagnostics').click();
  await expect(page.getByTestId('diagnostic-authentication')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('diagnostic-discovery')).toContainText(/environment/i);
  await expect(page.getByTestId('diagnostic-write')).toContainText(/never probed|disabled/);
  await expect(page.getByTestId('diagnostic-write').getByLabel('Not tested')).toBeVisible();
});
