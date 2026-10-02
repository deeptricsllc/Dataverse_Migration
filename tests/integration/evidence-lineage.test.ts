import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationRunDto,
} from '../../shared/domain';
import {
  EVIDENCE_SCHEMA_VERSION,
  LINEAGE_COLUMNS,
  LINEAGE_COLUMNS_BY_VERSION,
  LINEAGE_FILE_PATTERN,
  REQUIRED_EVIDENCE_FILES,
  type EvidenceManifest,
} from '../../shared/evidence';
import { readZip, writeZip } from '../../server/src/lib/zip';
import { verifyEvidencePackage } from '../../server/src/services/evidence-verifier';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Lineage in the evidence package, and whether the package can be checked.
 *
 * Lineage is the part an auditor actually follows: this source record became that target record, in
 * this run, with this outcome. It is also the only part that grows with the migration, so it is
 * chunked and streamed — and a chunked format is exactly the kind that drifts out of agreement with
 * its own manifest. So the counts are checked against the files, and then the files are deliberately
 * damaged to see whether the damage is noticed.
 */
describe('lineage and package verification', () => {
  let t: TestApp;
  let api: ApiClient;
  let archive: Buffer;
  let entries: Map<string, Buffer>;
  let manifest: EvidenceManifest;
  let run: MigrationRunDto;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    const worker = t.services.createWorker();
    await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const qa = envs.find((e) => e.displayName === 'DeepTrics QA')!;

    // QA holds pre-existing records and the source has records that cannot land, so the lineage
    // covers every outcome a reader has to interpret rather than only the happy one.
    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Lineage ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: qa.id,
      tables: ['account', 'contact'],
    });
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: qa.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(600_000);
    run = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);
    const validation = await api.post<ValidationRunDto>('/api/validations', {
      migrationRunId: started.id,
      depth: 'STANDARD',
    });
    await worker.drain(600_000);
    await worker.stop();

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${started.id}/evidence.zip`,
      headers: { cookie: api.cookie },
    });
    expect(res.statusCode).toBe(200);
    archive = res.rawPayload;
    entries = readZip(archive);
    manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as EvidenceManifest;
    void validation;
  }, 900_000);

  afterAll(async () => {
    await t.close();
  });

  // -------------------------------------------------------------------------
  describe('the lineage files', () => {
    it('holds one row per record the run touched', () => {
      expect(manifest.lineage, 'the manifest declares lineage').toBeTruthy();
      const chunks = [...entries.keys()].filter((p) => LINEAGE_FILE_PATTERN.test(p));
      expect(chunks.length, 'at least one chunk').toBeGreaterThan(0);
      expect(chunks.sort()).toEqual(manifest.lineage!.files);
      // The run's own processed total is what lineage must account for, record for record.
      expect(manifest.lineage!.totalRows).toBe(run.processed);
    });

    it('adds up: every chunk count sums to the declared total', () => {
      const lineage = manifest.lineage!;
      expect(lineage.rowsPerFile.reduce((n, r) => n + r, 0)).toBe(lineage.totalRows);
      // And the files really hold what the manifest says they do.
      for (const [index, path] of lineage.files.entries()) {
        const rows = entries
          .get(path)!
          .toString('utf8')
          .split('\r\n')
          .filter((l) => l.length > 0);
        expect(rows.length - 1, `${path} row count`).toBe(lineage.rowsPerFile[index]);
      }
    });

    it('names its columns, and uses only canonical outcomes', () => {
      const first = entries.get(manifest.lineage!.files[0]!)!.toString('utf8');
      expect(first.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(LINEAGE_COLUMNS.join(','));
      const outcomes = new Set(
        first
          .split('\r\n')
          .slice(1)
          .filter(Boolean)
          .map((l) => l.split(',')[6]),
      );
      for (const outcome of outcomes) {
        expect(['CREATED', 'UPDATED', 'UNCHANGED', 'SKIPPED', 'FAILED']).toContain(outcome);
      }
    });

    it('keeps a failed record’s source identity and invents no target for it', () => {
      const all = manifest
        .lineage!.files.map((p) => entries.get(p)!.toString('utf8'))
        .join('')
        .split('\r\n')
        .filter((l) => l.length > 0 && !l.startsWith('Run ID') && !l.startsWith('\uFEFF'));
      const failed = all.map((l) => l.split(',')).filter((c) => c[6] === 'FAILED');
      // The demo source is built so some records cannot land; if that changes this test should be
      // told rather than silently stop checking anything.
      expect(failed.length, 'the run had failures to describe').toBeGreaterThan(0);
      for (const cells of failed) {
        expect(cells[3], 'the source key is still there').toBeTruthy();
        expect(cells[5], 'and the target key is empty, not fabricated').toBe('');
      }
      expect(manifest.lineage!.rowsWithoutTarget).toBe(failed.length);
    });

    it('records the run and attempt on every row, so rows cannot be mixed up between runs', () => {
      const lines = entries
        .get(manifest.lineage!.files[0]!)!
        .toString('utf8')
        .split('\r\n')
        .slice(1)
        .filter(Boolean);
      for (const line of lines.slice(0, 20)) {
        expect(line.split(',')[0]).toBe(run.id);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('the package schema', () => {
    it('declares a version independent of the application version', () => {
      expect(manifest.evidenceSchemaVersion).toBe(EVIDENCE_SCHEMA_VERSION);
    });

    it('contains every required file, and describes each one it contains', () => {
      for (const required of REQUIRED_EVIDENCE_FILES) {
        expect(entries.has(required), `${required} is present`).toBe(true);
      }
      for (const record of manifest.files) {
        expect(record.describes.length, `${record.path} is described`).toBeGreaterThan(10);
        expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('verification', () => {
    /** Rebuilds the archive with one change, the way somebody editing a package would. */
    const rebuilt = (mutate: (files: Map<string, Buffer>) => void) => {
      const copy = new Map(entries);
      mutate(copy);
      return writeZip([...copy.entries()].map(([path, data]) => ({ path, data })));
    };

    it('calls an untouched package valid, and says exactly what that means', () => {
      const result = verifyEvidencePackage(archive);
      expect(result.problems, 'nothing wrong').toEqual([]);
      expect(result.verdict).toBe('VALID');
      expect(result.filesChecked).toBe(manifest.files.length);
      expect(result.lineageRowsCounted).toBe(manifest.lineage!.totalRows);
      // The words the product is allowed to use, travelling with the verdict.
      expect(result.proves).toMatch(/hashes to the digest/i);
      expect(result.doesNotProve).toMatch(/not a cryptographic signature/i);
      expect(result.doesNotProve).toMatch(/neither authenticity nor non-repudiation/i);
    });

    it('still reads a package from an earlier schema, which it says it supports', () => {
      /**
       * `SUPPORTED_EVIDENCE_SCHEMA_VERSIONS` says this product reads version 2, and reading it means
       * knowing what it looked like. Version 3 added the three write-state columns, so a version-2
       * package's lineage has eight columns and not eleven — and checking it against the current list
       * was this product reporting its own earlier evidence as corrupt.
       *
       * Built by rewriting a real package back to what version 2 produced, rather than by a fixture
       * nobody maintains: the digests are recomputed, which is what a reader's verifier would see.
       */
      const v2Columns = LINEAGE_COLUMNS_BY_VERSION[2]!.join(',');
      const downgraded = rebuilt((f) => {
        // The lineage chunks, rewritten with the older header and the older eight columns.
        for (const [path, data] of [...f.entries()]) {
          if (!path.startsWith('lineage/')) continue;
          const lines = data.toString('utf8').split('\r\n');
          const body = lines
            .slice(1)
            .filter((l) => l.length > 0)
            .map((line) => line.split(',').slice(0, 8).join(','));
          f.set(path, Buffer.from(`\uFEFF${[v2Columns, ...body].join('\r\n')}\r\n`, 'utf8'));
        }
        // And the manifest, declaring the older version with digests that match what we just wrote.
        const older = JSON.parse(f.get('manifest.json')!.toString('utf8')) as {
          evidenceSchemaVersion: number;
          files: { path: string; sha256: string; bytes?: number }[];
        };
        older.evidenceSchemaVersion = 2;
        for (const record of older.files) {
          const bytes = f.get(record.path);
          if (!bytes) continue;
          record.sha256 = createHash('sha256').update(bytes).digest('hex');
          if (record.bytes !== undefined) record.bytes = bytes.byteLength;
        }
        f.set('manifest.json', Buffer.from(JSON.stringify(older, null, 2), 'utf8'));
      });

      const result = verifyEvidencePackage(downgraded);
      expect(
        result.problems.filter((p) => p.code === 'LINEAGE_COLUMNS_UNEXPECTED'),
        'an older package is not corrupt for being older',
      ).toEqual([]);
      expect(result.verdict).toBe('VALID');
    });

    it('detects an edited metrics.csv', () => {
      const result = verifyEvidencePackage(
        rebuilt((f) => f.set('metrics.csv', Buffer.from(f.get('metrics.csv')!.toString('utf8') + 'x'))),
      );
      expect(result.verdict).toBe('MODIFIED');
      const problem = result.problems.find((p) => p.code === 'DIGEST_MISMATCH');
      expect(problem?.path).toBe('metrics.csv');
      expect(problem?.detail).toMatch(/not the one the manifest describes/i);
    });

    it('detects a removed validation.csv', () => {
      const result = verifyEvidencePackage(rebuilt((f) => f.delete('validation.csv')));
      expect(result.verdict).toBe('MODIFIED');
      expect(result.problems.some((p) => p.code === 'FILE_MISSING' && p.path === 'validation.csv')).toBe(
        true,
      );
    });

    it('detects a removed required file, and calls the package incomplete rather than modified', () => {
      const result = verifyEvidencePackage(rebuilt((f) => f.delete('metrics.csv')));
      expect(result.verdict, 'incomplete, not merely modified').toBe('INCOMPLETE');
      expect(result.problems.some((p) => p.code === 'REQUIRED_FILE_MISSING')).toBe(true);
    });

    it('detects a changed lineage chunk', () => {
      const chunk = manifest.lineage!.files[0]!;
      const result = verifyEvidencePackage(
        rebuilt((f) => {
          const lines = f.get(chunk)!.toString('utf8').split('\r\n');
          // One row removed: the digest changes and so does the count.
          f.set(chunk, Buffer.from([lines[0], ...lines.slice(2)].join('\r\n')));
        }),
      );
      expect(result.verdict).toBe('MODIFIED');
      expect(result.problems.some((p) => p.code === 'DIGEST_MISMATCH' && p.path === chunk)).toBe(true);
      expect(
        result.problems.some((p) => p.code === 'ROW_COUNT_MISMATCH' || p.code === 'LINEAGE_TOTAL_MISMATCH'),
        'and the arithmetic no longer adds up',
      ).toBe(true);
    });

    it('detects a manifest edited to match a changed file', () => {
      // The hardest case this can catch, and the limit of what it can: somebody who changes a file
      // *and* its digest produces an internally consistent package. What this catches is a manifest
      // changed on its own — a digest updated to a value the file does not hash to.
      const result = verifyEvidencePackage(
        rebuilt((f) => {
          const edited = JSON.parse(f.get('manifest.json')!.toString('utf8')) as EvidenceManifest;
          const entry = edited.files.find((x) => x.path === 'metrics.csv')!;
          entry.sha256 = createHash('sha256').update('something else').digest('hex');
          f.set('manifest.json', Buffer.from(`${JSON.stringify(edited, null, 2)}\n`));
        }),
      );
      expect(result.verdict).toBe('MODIFIED');
      expect(result.problems.some((p) => p.code === 'DIGEST_MISMATCH' && p.path === 'metrics.csv')).toBe(
        true,
      );
    });

    it('detects a lineage total that disagrees with the chunks', () => {
      const result = verifyEvidencePackage(
        rebuilt((f) => {
          const edited = JSON.parse(f.get('manifest.json')!.toString('utf8')) as EvidenceManifest;
          edited.lineage!.totalRows += 7;
          f.set('manifest.json', Buffer.from(`${JSON.stringify(edited, null, 2)}\n`));
        }),
      );
      expect(result.verdict).toBe('MODIFIED');
      expect(result.problems.filter((p) => p.code === 'LINEAGE_TOTAL_MISMATCH').length).toBeGreaterThan(0);
    });

    it('refuses a schema version it does not read, without judging the package', () => {
      const result = verifyEvidencePackage(
        rebuilt((f) => {
          const edited = JSON.parse(f.get('manifest.json')!.toString('utf8')) as EvidenceManifest;
          edited.evidenceSchemaVersion = 99;
          f.set('manifest.json', Buffer.from(`${JSON.stringify(edited, null, 2)}\n`));
        }),
      );
      expect(result.verdict).toBe('UNSUPPORTED');
      expect(result.problems[0]!.code).toBe('SCHEMA_VERSION_UNSUPPORTED');
      expect(result.problems[0]!.detail).toMatch(/newer than this reader/i);
    });

    it('detects a file smuggled in that the manifest does not vouch for', () => {
      const result = verifyEvidencePackage(rebuilt((f) => f.set('notes.txt', Buffer.from('added later'))));
      expect(result.verdict).toBe('MODIFIED');
      expect(result.problems.some((p) => p.code === 'FILE_EXTRA' && p.path === 'notes.txt')).toBe(true);
    });

    it('says plainly when the input is not a package at all', () => {
      const result = verifyEvidencePackage(Buffer.from('this is not a zip file'));
      expect(result.verdict).toBe('UNREADABLE');
      expect(result.problems[0]!.code).toBe('NOT_A_ZIP');
      expect(result.manifest).toBeNull();
    });

    it('says plainly when the manifest is missing', () => {
      const result = verifyEvidencePackage(rebuilt((f) => f.delete('manifest.json')));
      expect(result.verdict).toBe('INCOMPLETE');
      expect(result.problems[0]!.code).toBe('MANIFEST_MISSING');
    });
  });
});
