import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { TERMINAL_RUN_STATUSES, type MigrationRunStatus } from '../shared/domain';

/**
 * The validation experience, state by state, at the two widths it is reviewed at.
 *
 * Every state here is produced by the real engine: a plan configured, a migration run, a validation
 * executed, and in one case a deliberate lost answer armed against the simulated target. Nothing is
 * written into the database to make a screen appear, and nothing is asserted against a fixture.
 *
 * Two jobs in one file on purpose. The assertions make it a test, so a state that stops being
 * reachable fails the suite rather than quietly disappearing from a review. The screenshots make it
 * the review: set `CAPTURE_DIR` and each state is written at 1440x900 and 1920x1080, which is the
 * evidence a certification report refers to. Point `E2E_BASE_URL` at a deployment and the same file
 * reviews the deployed build.
 *
 * Serial, because the states build on each other: a validation cannot be reviewed before a run
 * exists to validate.
 */

const CAPTURE_DIR = process.env.CAPTURE_DIR;
/** The two widths the review is done at. */
const WIDTHS = [
  { label: '1440x900', width: 1440, height: 900 },
  { label: '1920x1080', width: 1920, height: 1080 },
];

/*
 * Serial, and long.
 *
 * The review drives several migrations and validations through the real engine and writes
 * forty-eight screenshots, which is well past the suite's ordinary budget. A tighter limit does not
 * make the review faster; it makes it stop halfway and report fewer states than it reached.
 */
test.describe.configure({ mode: 'serial', timeout: 2_400_000 });

/** Every state written, in order, so the report can count files rather than claims. */
const captured: string[] = [];

/**
 * One state, at both widths.
 *
 * Numbered in the order they are captured, so a reader comparing the directory against the brief's
 * list does not have to match on wording. A state the run could not reach is never written, which is
 * why the count in the report is a count of files.
 */
async function shot(page: Page, name: string) {
  captured.push(name);
  if (!CAPTURE_DIR) return;
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    // The page reflows on resize, and a screenshot taken mid-reflow shows neither layout.
    await page.waitForTimeout(250);
    const dir = `${CAPTURE_DIR}/${w.label}`;
    mkdirSync(dir, { recursive: true });
    await page.screenshot({
      path: `${dir}/${String(captured.length).padStart(2, '0')}-${name}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: WIDTHS[0]!.width, height: WIDTHS[0]!.height });
}

/**
 * The API, through the browser's own session. Setup only: every screen is reviewed in the UI.
 *
 * A write needs the session's CSRF token in a header, exactly as the application's own client sends
 * it. Read once per test and reused: the token belongs to the session, not to the request.
 */
let csrf = '';
const api = {
  get: async (page: Page, url: string) => {
    const res = await page.request.get(url);
    expect(res.ok(), `GET ${url} -> ${res.status()}`).toBe(true);
    return res.json();
  },
  post: async (page: Page, url: string, body: unknown = {}) => {
    const res = await page.request.post(url, { data: body, headers: { 'x-csrf-token': csrf } });
    expect(res.ok(), `POST ${url} -> ${res.status()} ${await res.text()}`).toBe(true);
    return res.json();
  },
  patch: async (page: Page, url: string, body: unknown = {}) => {
    const res = await page.request.patch(url, { data: body, headers: { 'x-csrf-token': csrf } });
    expect(res.ok(), `PATCH ${url} -> ${res.status()} ${await res.text()}`).toBe(true);
    return res.json();
  },
  put: async (page: Page, url: string, body: unknown = {}) => {
    const res = await page.request.put(url, { data: body, headers: { 'x-csrf-token': csrf } });
    expect(res.ok(), `PUT ${url} -> ${res.status()} ${await res.text()}`).toBe(true);
    return res.json();
  },
};

const signIn = async (page: Page) => {
  await page.goto('/');
  await page.getByTestId('try-demo-primary').first().click();
  await expect(page.getByRole('heading', { name: /Welcome, Demo/ })).toBeVisible();
  csrf = (await api.get(page, '/api/auth/session')).csrfToken;
  expect(csrf, 'the session carries a CSRF token').toBeTruthy();

  /*
   * Which build is being reviewed, read from the build rather than assumed.
   *
   * Set EXPECTED_SHA when reviewing a deployment. A review of the wrong image is worse than no
   * review: it reports that a change works when nothing has been looked at, which is the failure
   * `scripts/deploy.mjs` exists to prevent on the way in and this line prevents on the way out.
   */
  if (process.env.EXPECTED_SHA) {
    const settings = await api.get(page, '/api/settings');
    /*
     * A prefix, because the build reports the commit shortened to twelve characters — enough to
     * identify it without implying the whole hash means something to a reader. The comparison is
     * still exact in the direction that matters: a different commit cannot share this prefix.
     */
    expect(
      String(process.env.EXPECTED_SHA).startsWith(String(settings.build?.commit)),
      `deployment reports ${settings.build?.commit}, candidate is ${process.env.EXPECTED_SHA}`,
    ).toBe(true);
    expect(settings.build?.commit, 'and it reports one at all').toBeTruthy();
    console.warn(`[provenance] ${settings.build.branch}@${settings.build.commit}`);
  }
  // The worked examples are built on first sign-in. Validation has nothing to show until they are.
  await expect(async () => {
    const status = await api.get(page, '/api/demo/status');
    expect(status.status, `demo setup is ${status.status}`).toBe('READY');
  }).toPass({ timeout: 240_000 });
};

type Report = {
  id: string;
  status: string;
  outcome: string | null;
  migrationRunId: string | null;
  entities: {
    logicalName: string;
    displayName: string;
    outcome: string;
    duplicates: { occurrences: number }[] | null;
    checks: { check: string; outcome: string; message: string }[];
  }[];
};

/** Waits for a validation to reach a terminal status, then returns the report. */
const settled = async (page: Page, id: string): Promise<Report> => {
  let report: Report | null = null;
  await expect(async () => {
    report = await api.get(page, `/api/validations/${id}`);
    expect(['COMPLETED', 'FAILED'], `still ${report!.status}`).toContain(report!.status);
  }).toPass({ timeout: 300_000 });
  return report!;
};

/** Executes a plan and waits for the run to stop, whatever it stops as. */
const execute = async (page: Page, planId: string): Promise<string> => {
  const current = await api.get(page, `/api/plans/${planId}`);
  const run = await api.post(page, `/api/plans/${planId}/execute`, {
    confirmSourceName: current.sourceEnvironment.displayName,
    confirmTargetName: current.targetEnvironment.displayName,
    acknowledgeWarnings: true,
  });
  await expect(async () => {
    const r = await api.get(page, `/api/runs/${run.id}`);
    expect([...TERMINAL_RUN_STATUSES], `run is ${r.status}`).toContain(r.status);
  }).toPass({ timeout: 300_000 });
  return run.id as string;
};

/** Runs a migration over the demo pair and returns the run, then validates it. */
const migrateAndValidate = async (
  page: Page,
  name: string,
  sourceId: string,
  targetId: string,
  tables: string[],
) => {
  const plan = await api.post(page, '/api/plans', {
    name: `${name} ${Date.now()}`,
    sourceEnvironmentId: sourceId,
    targetEnvironmentId: targetId,
    tables,
  });
  const current = await api.get(page, `/api/plans/${plan.id}`);
  const run = await api.post(page, `/api/plans/${plan.id}/execute`, {
    confirmSourceName: current.sourceEnvironment.displayName,
    confirmTargetName: current.targetEnvironment.displayName,
    acknowledgeWarnings: true,
  });
  await expect(async () => {
    const r = await api.get(page, `/api/runs/${run.id}`);
    /*
     * The product's own list of terminal statuses, not one written out here.
     *
     * A hand-written copy was missing `NEEDS_RECONCILIATION`, which is exactly the status a run with
     * a lost write ends in — so the review waited out its whole budget on the one run it was
     * deliberately causing.
     */
    expect([...TERMINAL_RUN_STATUSES], `run is ${r.status}`).toContain(r.status);
  }).toPass({ timeout: 300_000 });
  const validation = await api.post(page, '/api/validations', { migrationRunId: run.id });
  return { runId: run.id as string, report: await settled(page, validation.id) };
};

/** Opens a report, filtered to one finding category, and returns how many there are. */
const openFindings = async (page: Page, validationId: string, type?: string) => {
  await page.goto(`/validation/${validationId}`);
  await expect(page.getByTestId('validation-verdict')).toBeVisible();
  if (type) {
    const page1 = await api.get(page, `/api/validations/${validationId}/differences?limit=1&type=${type}`);
    if (page1.total === 0) return 0;
    await page.getByLabel('Difference type').selectOption(type);
  }
  const anchor = page.locator('#differences');
  await anchor.scrollIntoViewIfNeeded();
  const rows = page.getByTestId('difference-row');
  await expect(rows.first()).toBeVisible();
  return rows.count();
};

test('the validation experience, state by state', async ({ page }) => {
  await signIn(page);
  const envs: { id: string; displayName: string }[] = await api.get(page, '/api/environments');
  const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
  const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;

  /*
   * The two ends of the independent comparison, chosen explicitly.
   *
   * The screen reads them from the workspace, so a review that assumes whatever a previous session
   * left there is reviewing a different pair than it reports. Set once, here.
   */
  await api.put(page, '/api/workspace', {
    sourceEnvironmentId: dev.id,
    targetEnvironmentId: uat.id,
  });

  // ------------------------------------------------------------------- 1. Overview
  await page.goto('/validation');
  await expect(page.getByRole('heading', { name: 'Validation', exact: true })).toBeVisible();
  await expect(page.getByText('Validate a migration run')).toBeVisible();
  await expect(page.getByText('Validate environment tables')).toBeVisible();
  await shot(page, 'validation-project-overview');

  // -------------------------------------------------- 2. Add comparison datasets
  /*
   * The independent workflow: the tables to compare are chosen here, with no migration involved.
   *
   * A table is offered only once the two schemas have been compared, which is the product being
   * careful rather than unhelpful — a table that exists on one side only cannot be compared record
   * by record, and offering it would produce a validation that could only ever be incomplete. So the
   * comparison runs first, the way a person would run it.
   */
  await expect(page.getByRole('heading', { name: 'Validate environment tables' })).toBeVisible();
  const comparison = await api.post(page, '/api/comparisons', {
    sourceEnvironmentId: dev.id,
    targetEnvironmentId: uat.id,
  });
  await expect(async () => {
    const c = await api.get(page, `/api/comparisons/${comparison.id}`);
    expect(['COMPLETED', 'FAILED'], `schema comparison is ${c.status}`).toContain(c.status);
  }).toPass({ timeout: 300_000 });
  await page.goto('/validation');
  const datasets = page.getByTestId('validation-datasets');
  await expect(datasets).toBeVisible();
  await datasets.locator('input[type="checkbox"]').first().check();
  await datasets.locator('input[type="checkbox"]').nth(1).check();
  await expect(page.getByTestId('validate-datasets')).toBeEnabled();
  await datasets.scrollIntoViewIfNeeded();
  await shot(page, 'add-comparison-datasets');

  // ---------------------------------------------------------------- 5. Ready
  const runs: { id: string; status: string; total: number | null }[] = await api.get(page, '/api/runs');
  const finished = runs.filter((r) => TERMINAL_RUN_STATUSES.has(r.status as MigrationRunStatus));
  expect(finished.length, 'the worked examples left runs to validate').toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Validate run' })).toBeEnabled();
  await shot(page, 'validation-ready');

  // ---------------------------------------------------------------- 6. Blocked
  // No source and target chosen, so the independent comparison has nothing to compare. A real
  // state: it is what a new workspace shows before anybody picks the two ends.
  await api.put(page, '/api/workspace', { sourceEnvironmentId: null, targetEnvironmentId: null });
  await page.goto('/validation');
  await expect(page.getByText('Select a source and target first.')).toBeVisible();
  await shot(page, 'validation-blocked');
  await api.put(page, '/api/workspace', { sourceEnvironmentId: dev.id, targetEnvironmentId: uat.id });

  // ------------------------------------------- 23. Migration-run validation handoff
  await page.goto(`/runs/${finished[0]!.id}`);
  await expect(page.getByRole('heading', { name: 'Migration run' })).toBeVisible();
  await shot(page, 'migration-run-validation-handoff');

  /*
   * 7. Running.
   *
   * Caught, not written. A validation is queued and the report page is opened straight away, so what
   * is captured is the real screen a person sees while one is executing. The screen is reached
   * before the worker can pick the job up, which is a race the test does not pretend to control: on
   * a fast machine with a small dataset the work can be over before the first paint. It is captured
   * when it is reached and reported as not reached when it is not — the one thing it must never do
   * is write a status into the page to make a screenshot.
   */
  // The longest run available, at FULL depth, so the work lasts as long as this data can make it.
  const widest = [...finished].sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0]!;
  const live = await api.post(page, '/api/validations', {
    migrationRunId: widest.id,
    depth: 'FULL',
  });
  await page.goto(`/validation/${live.id}`);
  /*
   * Watched for a moment rather than sampled once, and only for as long as the validation is
   * genuinely still going. No delay is added to the product to make the window wider.
   */
  let running = false;
  for (let i = 0; i < 20 && !running; i++) {
    const current = await api.get(page, `/api/validations/${live.id}`);
    if (current.status === 'COMPLETED' || current.status === 'FAILED') break;
    running = await page
      .getByTestId('validation-progress')
      .isVisible()
      .catch(() => false);
    if (!running) await page.waitForTimeout(100);
  }
  if (running) {
    // What it says while it runs, not only that it is running.
    await expect(page.getByTestId('validation-progress')).toContainText(/compare|Comparing|Validating/);
    await shot(page, 'validation-running');
  }
  await settled(page, live.id);

  // ------------------------------------------------- 8 or 9. Passed, or with warnings
  const existing: { id: string; outcome: string | null }[] = await api.get(page, '/api/validations');
  const agreed = existing.find((v) => v.outcome === 'PASS' || v.outcome === 'WARNING');
  expect(agreed, 'the worked examples left a validation that agreed').toBeTruthy();
  const agreedReport = await settled(page, agreed!.id);

  /*
   * Passed, and passed with warnings, are two states and two screens.
   *
   * One says the target holds what the migration should have produced. The other says that *and*
   * something is worth knowing — a pre-existing difference, a total that could not be reconciled.
   * A review that captured whichever one came first would not show that the product tells them
   * apart, so both are captured where both exist.
   */
  await page.goto(`/validation/${agreed!.id}`);
  await expect(page.getByTestId('validation-verdict')).toBeVisible();
  await expect(page.getByTestId('validation-verdict'), 'the headline ends with what to do').toContainText(
    'Next action',
  );
  await shot(page, agreedReport.outcome === 'PASS' ? 'validation-passed' : 'validation-passed-with-warnings');

  /*
   * 9. Passed with warnings, which is a different state from passed and must not be the same screen.
   *
   * Regions into QA, where every one of them is already present, so the run leaves them all as they
   * are. Then one of those records is changed in the target. A difference found in a record the run
   * did not write is a pre-existing difference and a warning: the data disagrees, and this migration
   * did not cause it and is not answerable for it. Everything the run did write still agrees, so the
   * headline is a pass that carries something worth knowing — which is exactly this state.
   */
  const warningTarget = envs.find((e) => e.displayName === 'DeepTrics QA')!;
  const skipped = await migrateAndValidate(page, 'Regions already there', dev.id, warningTarget.id, [
    'dtx_region',
  ]);
  /*
   * A record the run *skipped*, asked for by outcome rather than picked off the top of the list.
   *
   * It has to be one the run did not write. Taking the first record of the table took one the run
   * had created, and a difference in a record the run created is a plain mismatch and a failure —
   * the opposite of the state this is for.
   */
  const skippedMaps: { items: { sourceId: string; targetId: string | null; entity: string }[] } =
    await api.get(page, `/api/runs/${skipped.runId}/records?limit=50&entity=dtx_region&outcome=SKIPPED`);
  const untouched = skippedMaps.items.find((m) => m.targetId);
  expect(untouched, 'a region the run found already in the target and left alone').toBeTruthy();
  await api.post(page, '/api/demo/target-edit', {
    environmentId: warningTarget.id,
    table: 'dtx_region',
    recordId: untouched!.targetId,
    set: { dtx_name: 'Renamed by somebody else, before this run' },
  });
  const warned = await api.post(page, '/api/validations', { migrationRunId: skipped.runId });
  const warnedReport = await settled(page, warned.id);
  expect(warnedReport.outcome, `outcome was ${warnedReport.outcome}`).toBe('WARNING');
  await page.goto(`/validation/${warned.id}`);
  const warnedVerdict = page.getByTestId('validation-verdict');
  await expect(warnedVerdict).toBeVisible();
  await expect(warnedVerdict, 'and it is a pass, not a failure').toContainText('Passed with warnings');
  await shot(page, 'validation-passed-with-warnings');

  // --------------------------------------------------------- 12. Dataset results
  const firstDataset = agreedReport.entities[0]!;
  await page.goto(`/validation/${agreed!.id}`);
  await expect(page.getByTestId('validation-verdict')).toBeVisible();
  await page.getByTestId(`validation-entity-${firstDataset.logicalName}`).click();
  await expect(page.getByTestId(`rules-${firstDataset.logicalName}`)).toBeVisible();
  // The table, not the panel inside it: the rules have their own state two shots further on, and a
  // review of "dataset results" that does not show the per-dataset counts reviews something else.
  await page.getByTestId(`validation-entity-${firstDataset.logicalName}`).scrollIntoViewIfNeeded();
  await shot(page, 'dataset-results');

  // ------------------------------------- 3 and 4. Identity, and the comparison rules
  const rules = page.getByTestId(`rules-${firstDataset.logicalName}`);
  await expect(rules, 'the identity the comparison paired on').toContainText('Identity');
  await expect(rules).toContainText('Migration identity map');
  await rules.scrollIntoViewIfNeeded();
  await shot(page, 'configure-identity');

  await page.getByTestId(`rules-fields-toggle-${firstDataset.logicalName}`).click();
  const fields = page.getByTestId(`rules-fields-${firstDataset.logicalName}`);
  await expect(fields).toBeVisible();
  await expect(fields, 'and the columns it did not compare, by name').toContainText('Not compared');
  await fields.scrollIntoViewIfNeeded();
  await shot(page, 'configure-comparison-rules');

  // ----------------------------------------------------- 10 and 13. Failed, missing records
  /*
   * A failure this review causes on purpose, in a table nothing else in it touches.
   *
   * It used to take whichever validation in the workspace had already failed, and fall back to
   * migrating offices into QA where some regions are missing. Both depended on what had run before:
   * once this review started migrating regions into QA for the warnings state, the offices had
   * regions to point at and the run that was supposed to fail passed. A review whose states depend
   * on their own order is a review that will certify the wrong thing the first time one is added.
   *
   * So: configuration records into UAT, which holds none, and then one of them is removed from the
   * target. The run wrote it, the target no longer has it, and nobody has explained that — which is
   * validation's own finding rather than a failure the run already reported.
   */
  const failRun = await migrateAndValidate(page, 'Record removed after the run', dev.id, uat.id, [
    'dtx_applicationconfig',
  ]);
  expect(failRun.report.outcome, 'clean before anything is removed').not.toBe('FAIL');
  const configRows: { items: { sourceId: string; targetId: string | null; entity: string }[] } =
    await api.get(page, `/api/runs/${failRun.runId}/records?limit=50&entity=dtx_applicationconfig`);
  const removed = configRows.items.find((m) => m.targetId);
  expect(removed, 'a record the run wrote').toBeTruthy();
  await api.post(page, '/api/demo/target-edit', {
    environmentId: uat.id,
    table: 'dtx_applicationconfig',
    recordId: removed!.targetId,
    remove: true,
  });
  const afterRemoval = await api.post(page, '/api/validations', { migrationRunId: failRun.runId });
  const failing = { report: await settled(page, afterRemoval.id) };
  expect(failing.report.outcome, `outcome was ${failing.report.outcome}`).toBe('FAIL');
  await page.goto(`/validation/${failing.report.id}`);
  await expect(page.getByTestId('validation-verdict')).toContainText('Next action');
  await shot(page, 'validation-failed');

  /*
   * Records that are not in the target, whichever way they got that way.
   *
   * Two categories, deliberately: `RECORD_FAILED_IN_RUN` is a record the run reported as failed and
   * this confirms, and `MISSING_IN_TARGET` is validation's own discovery — the run said it had dealt
   * with the record and the record is not there. Different next actions, so different categories.
   */
  let missingShown = false;
  for (const type of ['RECORD_FAILED_IN_RUN', 'MISSING_IN_TARGET']) {
    const probe = await api.get(
      page,
      `/api/validations/${failing.report.id}/differences?limit=1&type=${type}`,
    );
    if (probe.total === 0) continue;
    expect(await openFindings(page, failing.report.id, type)).toBeGreaterThan(0);
    missingShown = true;
    break;
  }
  expect(missingShown, 'a record that is not in the target').toBe(true);
  await shot(page, 'missing-records');

  // ------------------------------------------- 19 and 20. Record-level finding, technical details
  await page.getByTestId('difference-row').first().click();
  const detail = page.getByTestId('finding-detail');
  await expect(detail).toBeVisible();
  await expect(detail, 'the rule that produced it').toContainText('Rule applied');
  await expect(detail, 'what it costs').toContainText('Why it matters');
  await expect(detail, 'and what to do').toContainText('Next action');
  await detail.scrollIntoViewIfNeeded();
  await shot(page, 'record-level-finding');

  await expect(detail, 'the identifiers, last and behind the same disclosure').toContainText(
    'Technical details',
  );
  await shot(page, 'technical-details-expanded');

  // --------------------------------------------------- 21. Filters and pagination
  await page.getByLabel('Difference type').selectOption('');
  await expect(page.getByTestId('difference-row').first()).toBeVisible();
  await page.locator('#differences').scrollIntoViewIfNeeded();
  await shot(page, 'filters-and-pagination');

  // ------------------------------------------------------------ 22. Evidence export
  const summary = await page.request.get(`/api/validations/${failing.report.id}/summary.csv`);
  expect(summary.ok()).toBe(true);
  expect(await summary.text(), 'the rules travel with the evidence').toContain('Identity');
  const findings = await page.request.get(`/api/validations/${failing.report.id}/differences.csv`);
  expect(findings.ok()).toBe(true);
  expect(await findings.text(), 'and so does the next action').toContain('Next action');
  await expect(page.getByRole('link', { name: /Export differences/ })).toBeVisible();
  await shot(page, 'evidence-export');

  // ------------------------------------------------------------- 11. Incomplete
  // A write whose answer never arrives. The record may or may not be in the target, so it is left
  // out of the comparison and the report says it could not be completed.
  const armed = await api.post(page, '/api/demo/fault-injection', {
    environmentId: uat.id,
    table: 'product',
    onNthCreate: 2,
  });
  expect(armed.armed).toBe(true);
  // Products are in Development and not in UAT, so this run creates every one of them — which is
  // what the armed fault counts. A table the target already holds would produce no creates at all.
  const incomplete = await migrateAndValidate(page, 'Lost answer', dev.id, uat.id, ['product']);
  const unverified = incomplete.report.entities
    .flatMap((e) => e.checks)
    .filter((c) => c.outcome === 'INCOMPLETE');
  expect(unverified.length, 'a check that could not be completed').toBeGreaterThan(0);
  expect(incomplete.report.outcome, 'and the headline is not a pass').not.toBe('PASS');
  await page.goto(`/validation/${incomplete.report.id}`);
  const verdict = page.getByTestId('validation-verdict');
  await expect(verdict).toContainText('could not be completed');
  await expect(verdict, 'Incomplete is not a kind of pass').not.toContainText('Passed with warnings');
  /*
   * And it does not print the absolute claim above the limit. "Nothing is missing" is true only of
   * the records that were checked, and this report excluded one because nobody could account for it.
   */
  await expect(
    verdict,
    'the strongest sentence is not available to a report with a gap in it',
  ).not.toContainText('Nothing is missing');
  await shot(page, 'validation-incomplete');

  // --------------------------------------------- 14. Unexpected records in the target
  /*
   * There is no "unexpected record" finding for a migration validation, on purpose. The comparison
   * scope is the records this run claims, and a shared target holds rows from other sources, from
   * earlier runs and from people working in the system — so an unaccounted row is reported as a
   * row-count difference rather than as this migration's failure. This captures that reporting.
   */
  const withExtraRows = [...existing, { id: incomplete.report.id, outcome: null }];
  let rowCountState = false;
  for (const v of withExtraRows) {
    const report = await settled(page, v.id);
    const dataset = report.entities.find((e) =>
      e.checks.some((c) => c.check === 'ROW_COUNT' && /more row/.test(c.message)),
    );
    if (!dataset) continue;
    await page.goto(`/validation/${report.id}`);
    await page.getByTestId(`validation-entity-${dataset.logicalName}`).click();
    await expect(page.getByText(/more row\(s\) than source/).first()).toBeVisible();
    await shot(page, 'unexpected-records');
    rowCountState = true;
    break;
  }
  expect(rowCountState, 'a target holding rows this run did not write').toBe(true);

  // --------------- 15, 16, 17, 18. Mismatches, and an identity that is not single-valued
  /*
   * A target that stopped matching after the run.
   *
   * This is what a validation exists to catch, and none of it can be caused by configuring a
   * migration: a value edited by hand, a reference repointed by an integration, two records left
   * carrying one business key by a double import. So the records are really changed in the
   * simulated target, through the demo-only route that exists for exactly this, and the comparison
   * really finds them. See `/api/demo/target-edit`.
   *
   * Into QA, which holds no offices, so this run creates every one of them. It matters which records
   * the run wrote: a record the run found already in the target and left alone is reported as a
   * pre-existing difference and a warning, correctly, because the run did not write it.
   */
  const driftTarget = envs.find((e) => e.displayName === 'DeepTrics QA')!;
  const driftPlan = await api.post(page, '/api/plans', {
    name: `Drift ${Date.now()}`,
    sourceEnvironmentId: dev.id,
    targetEnvironmentId: driftTarget.id,
    tables: ['dtx_region', 'dtx_office'],
  });
  const officeEntity = (await api.get(page, `/api/plans/${driftPlan.id}`)).entities.find(
    (e: { logicalName: string }) => e.logicalName === 'dtx_office',
  );

  /*
   * A business key, so the duplicate scan has something to prove. On the primary identifier it can
   * only ever report that nothing repeats, which the target guarantees by itself.
   */
  await api.patch(page, `/api/plans/${driftPlan.id}/entities/${officeEntity.id}`, {
    matchStrategy: 'BUSINESS_KEY',
    alternateKey: null,
    businessKeyFields: ['dtx_name'],
  });

  /*
   * And a transformation, so one column is compared against what the value became rather than
   * against what it was. Without one there is no transformation mismatch to show, only a value
   * mismatch wearing the name.
   */
  const officeMappings = await api.get(
    page,
    `/api/plans/${driftPlan.id}/entities/${officeEntity.id}/mappings`,
  );
  const cityMapping = officeMappings.mappings.find(
    (m: { sourceField: string }) => m.sourceField === 'dtx_city',
  );
  await api.patch(page, `/api/plans/${driftPlan.id}/mappings/${cityMapping.id}/transformations`, {
    rules: [{ kind: 'UPPERCASE' }],
  });

  const driftRun = await execute(page, driftPlan.id);
  const cleanValidation = await api.post(page, '/api/validations', { migrationRunId: driftRun });
  await settled(page, cleanValidation.id);
  const beforeDrift = await api.get(
    page,
    `/api/validations/${cleanValidation.id}/differences?limit=50&entity=dtx_office`,
  );
  expect(beforeDrift.total, 'the offices this run created agree with the source').toBe(0);

  const maps: { items: { sourceId: string; targetId: string | null; entity: string }[] } = await api.get(
    page,
    `/api/runs/${driftRun}/records?limit=200`,
  );
  const officeRows = maps.items.filter((m) => m.entity === 'dtx_office' && m.targetId);
  const regionRows = maps.items.filter((m) => m.entity === 'dtx_region' && m.targetId);
  expect(officeRows.length, 'offices to change').toBeGreaterThan(4);
  expect(regionRows.length, 'regions to repoint at').toBeGreaterThan(1);

  const edit = (recordId: string | null, set: Record<string, unknown>) =>
    api.post(page, '/api/demo/target-edit', {
      environmentId: driftTarget.id,
      table: 'dtx_office',
      recordId,
      set,
    });

  // A number somebody typed over.
  await edit(officeRows[0]!.targetId, { dtx_headcount: 99999 });
  // A reference somebody repointed at a different record that really exists.
  await edit(officeRows[1]!.targetId, {
    dtx_regionid: { logicalName: 'dtx_region', id: regionRows[regionRows.length - 1]!.targetId },
  });
  /*
   * Two target records left carrying one business key, which is what a double import leaves behind.
   *
   * Both are given the same name, so neither can be said to be the one a source record matches. The
   * comparison reports the repeat and how many records carry it, and does not pick one.
   */
  const sharedName = 'Office that exists twice';
  await edit(officeRows[2]!.targetId, { dtx_name: sharedName });
  await edit(officeRows[3]!.targetId, { dtx_name: sharedName });

  /*
   * And a transformed column holding a value the transformation would never produce.
   *
   * The run uppercases this column on the way in, so the expected value is uppercase and the target
   * now holds lowercase text — which is what a transformed column looks like when something wrote
   * to it afterwards without applying the rule.
   */
  await edit(officeRows[4]!.targetId, { dtx_city: 'written without the transformation' });

  const afterDrift = await api.post(page, '/api/validations', { migrationRunId: driftRun });
  const driftReport = await settled(page, afterDrift.id);
  expect(driftReport.outcome, 'the comparison found the drift').toBe('FAIL');

  // 15. A field mismatch, on a column with no transformation on it.
  const fieldMismatches = await api.get(
    page,
    `/api/validations/${driftReport.id}/differences?limit=50&type=VALUE_MISMATCH&entity=dtx_office`,
  );
  expect(fieldMismatches.total, 'the values somebody edited').toBeGreaterThan(0);
  expect(await openFindings(page, driftReport.id, 'VALUE_MISMATCH')).toBeGreaterThan(0);
  await page.getByTestId('difference-row').first().click();
  await expect(page.getByTestId('finding-detail')).toBeVisible();
  await page.getByTestId('finding-detail').scrollIntoViewIfNeeded();
  await shot(page, 'field-mismatches');

  // 16. The same comparison, on the column the rules say was transformed.
  const transformedFinding = fieldMismatches.items.find(
    (x: { field: string | null }) => x.field === 'dtx_city',
  );
  expect(transformedFinding, 'the target holds the value from before the transformation ran').toBeTruthy();
  const officeDataset = driftReport.entities.find((e) => e.logicalName === 'dtx_office')!;
  await page.goto(`/validation/${driftReport.id}`);
  await page.getByTestId(`validation-entity-${officeDataset.logicalName}`).click();
  await page.getByTestId(`rules-fields-toggle-${officeDataset.logicalName}`).click();
  const ruleList = page.getByTestId(`rules-fields-${officeDataset.logicalName}`);
  await expect(ruleList, 'the rules name the transformation this column was compared under').toContainText(
    'Uppercase',
  );
  await ruleList.scrollIntoViewIfNeeded();
  await shot(page, 'transformation-mismatch');

  // 17. A record that exists in the target with the wrong parent.
  const relationshipMismatches = await api.get(
    page,
    `/api/validations/${driftReport.id}/differences?limit=50&type=LOOKUP_MISMATCH&entity=dtx_office`,
  );
  expect(relationshipMismatches.total, 'the reference somebody repointed').toBeGreaterThan(0);
  expect(await openFindings(page, driftReport.id, 'LOOKUP_MISMATCH')).toBeGreaterThan(0);
  await page.getByTestId('difference-row').first().click();
  const relationship = page.getByTestId('finding-detail');
  await expect(relationship).toContainText('Relationship mismatch');
  await expect(relationship, 'and what it costs').toContainText('wrong parent');
  await relationship.scrollIntoViewIfNeeded();
  await shot(page, 'relationship-mismatch');

  // 18. One business key on two target records, reported and not resolved.
  const duplicates = driftReport.entities.find(
    (e) => e.logicalName === 'dtx_office' && (e.duplicates ?? []).some((d) => d.occurrences > 1),
  );
  expect(
    duplicates,
    `duplicates: ${JSON.stringify(driftReport.entities.map((e) => [e.logicalName, e.duplicates]))}`,
  ).toBeTruthy();
  await page.goto(`/validation/${driftReport.id}`);
  await page.getByTestId(`validation-entity-dtx_office`).click();
  const duplicatePanel = page.getByTestId('duplicates-dtx_office');
  await expect(duplicatePanel).toBeVisible();
  await duplicatePanel.scrollIntoViewIfNeeded();
  await shot(page, 'duplicate-or-ambiguous-identity');

  // -------------------------------------------------- 24. Empty validation project
  // A comparison project with no datasets: the independent workflow before anything is added.
  const project = await api.post(page, '/api/projects', {
    name: `Empty comparison ${Date.now()}`,
    kind: 'COMPARISON',
    sourceEnvironmentId: dev.id,
    targetEnvironmentId: uat.id,
  });
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByTestId('comparisons')).toBeVisible();
  await shot(page, 'empty-validation-project');

  // The count the certification report quotes is the number of states this run actually reached.
  console.warn(`[states] ${captured.length} captured: ${captured.join(', ')}`);

  /*
   * Every state the product can be put into, by name. A count would pass on the wrong twenty-three.
   *
   * `validation-running` is not in this list, and it is the only one that is not. It is a state the
   * product really has, and whether a browser sees it depends on whether the work outlasts the
   * first paint — which on a small dataset it does not. It is captured when it is reached and
   * reported as not reached when it is not. Writing a status into the page to produce the
   * screenshot would make the review say something nobody observed, which is the one thing a
   * review may never do.
   */
  const required = [
    'validation-project-overview',
    'add-comparison-datasets',
    'configure-identity',
    'configure-comparison-rules',
    'validation-ready',
    'validation-blocked',
    'validation-passed',
    'validation-passed-with-warnings',
    'validation-failed',
    'validation-incomplete',
    'dataset-results',
    'missing-records',
    'unexpected-records',
    'field-mismatches',
    'transformation-mismatch',
    'relationship-mismatch',
    'duplicate-or-ambiguous-identity',
    'record-level-finding',
    'technical-details-expanded',
    'filters-and-pagination',
    'evidence-export',
    'migration-run-validation-handoff',
    'empty-validation-project',
  ];
  const missing = required.filter((name) => !captured.includes(name));
  expect(missing, `states not reached: ${missing.join(', ')}`).toEqual([]);
  console.warn(
    captured.includes('validation-running')
      ? '[states] validation-running was reached'
      : '[states] validation-running was not reached: the work finished before the page rendered',
  );
});
