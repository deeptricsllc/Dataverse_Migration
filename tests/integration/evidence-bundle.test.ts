import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationRunDto,
} from '../../shared/domain';
import { writtenByRun } from '../../shared/run-metrics';
import { readZip } from '../../server/src/lib/zip';
import type { EvidenceManifest } from '../../server/src/services/evidence-service';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The package a migration lead keeps.
 *
 * Its job is to be readable by somebody who was not there, after the environments have moved on
 * and nobody can re-run anything. So the tests are about what it says rather than whether it
 * downloads: that the numbers in it reconcile under the product's own definitions, that it states
 * what validation did *not* cover, that it is honest about how far the connectors have been
 * verified, and that it carries no credential.
 */
describe('migration evidence package', () => {
  let t: TestApp;
  let api: ApiClient;
  let worker: ReturnType<TestApp['services']['createWorker']>;
  let run: MigrationRunDto;
  let report: ValidationRunDto;
  let files: Map<string, Buffer>;
  let manifest: EvidenceManifest;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;

    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Evidence ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region', 'account'],
    });
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(180_000);
    const validation = await api.post<ValidationRunDto>('/api/validations', {
      migrationRunId: started.id,
      depth: 'FULL',
    });
    await worker.drain(180_000);
    run = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);
    report = await api.get<ValidationRunDto>(`/api/validations/${validation.id}`);

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${run.id}/evidence.zip`,
      headers: { cookie: api.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('zip');
    files = readZip(res.rawPayload);
    manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as EvidenceManifest;
  }, 300_000);

  afterAll(async () => {
    await worker.stop();
    await t.close();
  });

  it('carries the artefacts a reader needs and says what each one is for', () => {
    for (const path of [
      'summary.md',
      'metrics.csv',
      'validation.csv',
      'validation-coverage.json',
      'configuration.json',
      'connector-evidence.csv',
      'manifest.json',
    ]) {
      expect(files.has(path), `${path} is in the bundle`).toBe(true);
    }
    for (const record of manifest.files) {
      expect(record.describes, `${record.path} says what it is for`).toBeTruthy();
    }
  });

  it('reconciles with the run it describes', () => {
    // The numbers in the package must be the run's own, under the product's definitions. A package
    // that drifted from the run would be worse than no package.
    const metrics = files.get('metrics.csv')!.toString('utf8');
    const total = metrics.split(/\r?\n/).find((l) => l.startsWith('ALL TABLES'))!;
    const [, totalCol, processed, created, updated, unchanged, skipped, failed, written] = total.split(',');
    expect(Number(totalCol)).toBe(run.total);
    expect(Number(processed)).toBe(run.processed);
    expect(Number(created)).toBe(run.created);
    expect(Number(updated)).toBe(run.updated);
    expect(Number(unchanged)).toBe(run.unchanged);
    expect(Number(skipped)).toBe(run.skipped);
    expect(Number(failed)).toBe(run.failed);
    expect(Number(written), 'written is created plus updated and nothing else').toBe(writtenByRun(run));
    // And the mutually exclusive outcomes add back up to processed.
    expect(Number(created) + Number(updated) + Number(unchanged) + Number(skipped) + Number(failed)).toBe(
      Number(processed),
    );
  });

  it('states what validation did not cover, not only what it did', () => {
    const coverage = JSON.parse(files.get('validation-coverage.json')!.toString('utf8'));
    expect(coverage.summary.mode).toBe(report.summary!.coverage!.mode);
    expect(coverage.summary.examined).toBe(report.summary!.coverage!.examined);
    expect(coverage.summary.eligible).toBe(report.summary!.coverage!.eligible);
    expect(coverage.note, 'the package explains what SAMPLED and NOT VERIFIED mean').toMatch(/NOT_VERIFIED/);

    const summary = files.get('summary.md')!.toString('utf8');
    expect(summary).toContain('Coverage');
    // The sentence the whole sprint exists to prevent must not appear over a partial examination.
    if (report.summary!.coverage!.mode === 'SAMPLED') {
      expect(summary).toMatch(/not examined/i);
      expect(summary).not.toMatch(/all checks passed/i);
    }
  });

  it('is a sign-off a reader can reconcile, and names the build that produced it', () => {
    /**
     * The outcome table used to list five outcomes and claim they summed to `processed`. They did not:
     * `processed` counts unresolved records too — something was attempted and the answer was lost — so the
     * table failed to add up on exactly the runs where the numbers matter most. A sign-off document that
     * cannot be reconciled is worse than none.
     */
    const summary = files.get('summary.md')!.toString('utf8');
    /** Reads a row of the outcome table by splitting on pipes, which beats escaping a regex for it. */
    const figure = (label: string) => {
      for (const line of summary.split('\n')) {
        const cells = line.split('|').map((c) => c.replaceAll('*', '').trim());
        if (cells.length >= 3 && cells[1] === label) return Number(cells[2]);
      }
      throw new Error(`${label} is not in the outcome table`);
    };

    const parts = ['Created', 'Updated', 'Unchanged', 'Skipped', 'Failed', 'Unresolved'].map(figure);
    const processed = figure('Processed');
    expect(
      parts.reduce((a, b) => a + b, 0),
      'the outcomes add up to the processed total, as the document says they do',
    ).toBe(processed);
    expect(processed).toBe(run.processed);
    expect(figure('Written by this run')).toBe(run.created + run.updated);

    // Which build wrote it. The first question asked of a disputed report, and the one nobody can
    // answer from memory six months later.
    expect(summary).toContain('**Produced by** v');

    // The questions a sign-off has to answer, each findable in the document.
    for (const expected of [
      run.planName,
      run.sourceEnvironment.displayName,
      run.targetEnvironment.displayName,
    ]) {
      expect(summary, `the summary says ${expected}`).toContain(expected);
    }
    expect(summary).toContain('Validation');
    expect(summary).toContain('Integrity');
    // And what it refuses to claim about its own integrity.
    expect(summary).toContain('**not signed**');
  });

  it('tells a reader how to check the digests without this product', () => {
    /**
     * An auditor's whole position is that they do not take the operator's word for anything, and a package
     * whose only verifier is the vendor's own endpoint asks them to take ours. The digests are plain
     * SHA-256 of the bytes, so the check is a one-line command on any platform — and the package has to say
     * so, or the reader has no way to know.
     */
    const summary = files.get('summary.md')!.toString('utf8');
    expect(summary).toMatch(/shasum -a 256/);
    expect(summary).toMatch(/Get-FileHash/);
    expect(summary, 'and says the arithmetic is the authority rather than our endpoint').toMatch(
      /convenience, not the authority/i,
    );

    // And the claim is true: a digest in the manifest is the SHA-256 of that file's bytes, nothing else.
    const record = manifest.files.find((f) => f.path === 'metrics.csv')!;
    const computed = createHash('sha256').update(files.get('metrics.csv')!).digest('hex');
    expect(computed, 'the documented command would produce the documented value').toBe(record.sha256);
  });

  it('says how far the connectors themselves have been verified', () => {
    // A clean validation over a connector nobody has run against the real engine is a weaker
    // statement than the same validation over one that has, and the package must not hide that.
    const csv = files.get('connector-evidence.csv')!.toString('utf8');
    expect(csv).toContain('Verification');
    expect(csv, 'the demo Dataverse connector is reported as simulated').toMatch(/Simulated only/);
  });

  it('records a digest for every file, and is honest about what that proves', () => {
    for (const record of manifest.files) {
      const actual = createHash('sha256').update(files.get(record.path)!).digest('hex');
      expect(actual, `${record.path} matches its recorded digest`).toBe(record.sha256);
      expect(record.bytes).toBe(files.get(record.path)!.length);
    }
    // The manifest cannot contain its own digest, so it is not listed among the hashed files.
    expect(manifest.files.some((f) => f.path === 'manifest.json')).toBe(false);

    expect(manifest.integrity.algorithm).toBe('sha256');
    expect(manifest.integrity.doesNotProve, 'the limits are stated, not implied').toMatch(/not signed/i);
    expect(manifest.integrity.doesNotProve).toMatch(/not a cryptographic signature/i);
  });

  it('detects a file changed after the bundle was made', () => {
    // What the digests are actually for. Not tamper-proofing — somebody who edits a file can edit
    // the manifest too — but a changed file no longer matching is exactly what they catch.
    const original = files.get('metrics.csv')!;
    const edited = Buffer.from(original.toString('utf8').replace(/ALL TABLES,\d+/, 'ALL TABLES,999'));
    const record = manifest.files.find((f) => f.path === 'metrics.csv')!;
    expect(createHash('sha256').update(edited).digest('hex')).not.toBe(record.sha256);
  });

  it('contains no credential of any kind', () => {
    // The generator refuses a bundle that looks like it carries one; this scans the real output,
    // because "the generator would have refused" is a statement about the generator.
    const forbidden = [
      /"?password"?\s*[:=]\s*"[^"]+"/i,
      /\b(client_secret|clientSecret|refresh_token|access_token)\b/i,
      /[A-Za-z]+:\/\/[^\s/@]+:[^\s/@]+@/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    for (const [path, buffer] of files) {
      const text = buffer.toString('utf8');
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${path} must not match ${pattern}`).toBe(false);
      }
    }
  });
});
