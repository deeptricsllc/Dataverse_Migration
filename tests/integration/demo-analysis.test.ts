import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalysisAssessmentDto, ProjectDto } from '../../shared/domain';
import { EXPECTED_FINDINGS } from '../../server/src/demo/customer-modernization';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The worked example, built the way a user builds one.
 *
 * This is the test that decides whether the analysis experience is real. Everything in it goes through the
 * ordinary path — a file dataset is created, four CSVs are imported by the real importer, the dataset is
 * attached to an analysis project, the real analysis runs — and then the assessment is read back and
 * checked against the findings the dataset was designed to produce.
 *
 * The consequence is the point: if the importer breaks, the profiler regresses, or a finding rule stops
 * firing, **this fails**. A seeded fixture would keep looking impressive long after the product stopped
 * working, which is the failure mode the previous certification work was mostly about.
 */

describe('the Customer Data Modernization demo', () => {
  let t: TestApp;
  let api: ApiClient;
  let project: ProjectDto;
  let assessment: AnalysisAssessmentDto;

  let worker: ReturnType<TestApp['services']['createWorker']>;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    await api.demoLogin();
    project = await api.post<ProjectDto>('/api/demo/analysis-project');

    /**
     * The analysis is queued, not run inline — so the build returns a project whose analysis has not
     * happened yet, and the assessment would read "nothing has been analysed". That is correct product
     * behaviour, and it is the same shape as the defect that had the certification driver recording a
     * preflight's totals before the preflight ran. Here the test does what the worker does in production.
     */
    worker = t.services.createWorker();
    await worker.drain(300_000);
    assessment = await api.get<AnalysisAssessmentDto>(`/api/projects/${project.id}/assessment`);
  }, 300_000);

  afterAll(async () => {
    await worker?.stop();
    await t?.close();
  });

  it('is an analysis project with no target, built from one file dataset', () => {
    expect(project.kind).toBe('ANALYSIS');
    expect(project.targetEnvironment, 'analysis never has a target').toBeNull();
    expect(project.sources).toHaveLength(1);
    expect(assessment.datasets[0]?.analysed).toBe(true);
  });

  it('read all four files and the records in them', () => {
    // 400 customers, 300 contacts, 600 orders, 120 products.
    expect(assessment.tables).toBe(4);
    expect(assessment.records).toBe(1420);
  });

  it('is idempotent, so a second demo request does not create a second project', async () => {
    const again = await api.post<ProjectDto>('/api/demo/analysis-project');
    expect(again.id).toBe(project.id);
  });

  /**
   * The promise the dataset makes. `EXPECTED_FINDINGS` is exported from the generator precisely so this
   * can be asserted: if a rule stops firing, the failure names which one and which table.
   */
  it('produces every finding the dataset was designed to produce', () => {
    const missing = EXPECTED_FINDINGS.filter(
      (expected) =>
        !assessment.findings.some(
          (f) => f.id.includes(expected.rule) && f.table.toLowerCase().includes(expected.table.toLowerCase()),
        ),
    );
    expect(
      missing.map((m) => `${m.rule} on ${m.table} (${m.why})`),
      'each of these is planted in the data and should have been found',
    ).toEqual([]);
  });

  it('finds the headline problem: Contacts has nothing that identifies a record', () => {
    const critical = assessment.findings.filter((f) => f.severity === 'CRITICAL');
    const noKey = critical.find((f) => f.id.includes('NO_RELIABLE_KEY') && f.table.includes('ontact'));
    expect(noKey, 'the most consequential finding in the dataset').toBeTruthy();
    expect(noKey!.whyItMatters).toContain('creating duplicates');
    expect(noKey!.evidence.length).toBeGreaterThan(1);
  });

  it('reads the Excel serial dates in Orders as the dates they are', () => {
    const dates = assessment.findings.filter((f) => f.id.includes('DATE_AS_NUMBER'));
    expect(dates.length, 'order_date and ship_date').toBeGreaterThanOrEqual(2);
    expect(dates[0]!.summary).toMatch(/202\d-\d{2}-\d{2}/);
  });

  it('never reports a finding it cannot evidence', () => {
    for (const finding of assessment.findings) {
      expect(finding.evidence.length, `${finding.id} has no evidence`).toBeGreaterThan(0);
      expect(finding.whyItMatters.length, `${finding.id} does not say why it matters`).toBeGreaterThan(20);
      expect(finding.recommendation.length, `${finding.id} recommends nothing`).toBeGreaterThan(10);
      expect(['HIGH', 'MEDIUM']).toContain(finding.confidence);
    }
  });

  /** Orphaned orders exist in the data on purpose and are deliberately not claimed. */
  it('does not claim to have found orphaned references, because no rule looks for them', () => {
    const orphanClaims = assessment.findings.filter((f) => /orphan/i.test(`${f.title} ${f.summary}`));
    expect(orphanClaims, 'the data has orphans; the product must not pretend to have noticed').toEqual([]);
  });

  it('assesses readiness, and every deduction traces to a finding', () => {
    expect(assessment.readiness.score).not.toBeNull();
    expect(assessment.readiness.band).not.toBe('READY');
    for (const dimension of assessment.readiness.dimensions) {
      if (!dimension.assessed) {
        expect(dimension.notAssessedReason).toBeTruthy();
        continue;
      }
      // The arithmetic is shown, and the findings behind it are named.
      expect(dimension.workings).toMatch(/100|Nothing was found/);
      const deducted = dimension.critical + dimension.warning + dimension.info;
      expect(dimension.findingIds).toHaveLength(deducted);
      for (const id of dimension.findingIds) {
        expect(assessment.findings.some((f) => f.id === id)).toBe(true);
      }
    }
  });

  it('writes a summary that names the real problems rather than recommending better data', () => {
    expect(assessment.summary).toContain('Customer Data Modernization');
    expect(assessment.summary).toContain('1,420');
    expect(assessment.summary).toMatch(/critical/i);
    expect(assessment.summary).not.toContain('Improve data quality');
  });

  it('orders findings worst first, because that is the order to read them in', () => {
    const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
    const ranks = assessment.findings.map((f) => rank[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
