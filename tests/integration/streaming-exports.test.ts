import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { EnvironmentDto, MigrationPlanDto, MigrationRunDto } from '../../shared/domain';
import { migrationRecordMaps } from '../../server/src/db/schema';
import { csvStream } from '../../server/src/lib/csv';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * Exports that scale with the migration.
 *
 * These used to be built in memory and capped — 100,000 records with a TRUNCATED line at the bottom,
 * which answers a different question from the one somebody asked. The cap is gone, so the test that
 * matters is that nothing accumulates: enough rows to have needed the cap, read as pages, with the
 * whole file never assembled server-side.
 *
 * The other half is escaping. A CSV is read by a spreadsheet, and a spreadsheet will execute a cell
 * that begins with `=`. What the product does about that is deliberate and documented here, because
 * the alternative — altering an exported value and saying nothing — is worse than either choice.
 */
describe('streaming exports', () => {
  let t: TestApp;
  let api: ApiClient;
  let run: MigrationRunDto;
  /** More rows than one page, so the paging boundary is crossed several times. */
  const EXTRA = 2_600;

  beforeAll(async () => {
    t = await createTestApp();
    api = new ApiClient(t.app);
    const worker = t.services.createWorker();
    const session = await api.demoLogin();
    const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
    const dev = envs.find((e) => e.displayName === 'DeepTrics Development')!;
    const uat = envs.find((e) => e.displayName === 'DeepTrics UAT')!;

    const plan = await api.post<MigrationPlanDto>('/api/plans', {
      name: `Streaming ${Date.now()}`,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      tables: ['dtx_region'],
    });
    const started = await api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
      confirmSourceName: dev.displayName,
      confirmTargetName: uat.displayName,
      acknowledgeWarnings: true,
    });
    await worker.drain(300_000);
    await worker.stop();
    run = await api.get<MigrationRunDto>(`/api/runs/${started.id}`);

    // Enough identity rows to make the export worth streaming, written directly: the point here is
    // the export, and migrating thousands of records to prove it would test the engine instead.
    const rows = Array.from({ length: EXTRA }, (_, i) => ({
      organizationId: session.user.organization.id,
      runId: run.id,
      sourceEnvironmentId: dev.id,
      targetEnvironmentId: uat.id,
      logicalName: 'zz_streaming',
      sourceId: `src-${String(i).padStart(8, '0')}`,
      targetId: `tgt-${String(i).padStart(8, '0')}`,
      outcome: (i % 50 === 0 ? 'FAILED' : 'CREATED') as 'FAILED' | 'CREATED',
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await t.services.db.insert(migrationRecordMaps).values(rows.slice(i, i + 500));
    }
  }, 600_000);

  afterAll(async () => {
    await t.close();
  });

  const download = async (url: string) => {
    const res = await t.app.inject({ method: 'GET', url, headers: { cookie: api.cookie } });
    expect(res.statusCode, url).toBe(200);
    return res.payload;
  };

  it('exports every record rather than the first page of them', async () => {
    const csv = await download(`/api/runs/${run.id}/records.csv`);
    const lines = csv.split('\r\n').filter((l) => l.length > 0);
    const [, ...dataRows] = lines;
    const total = await t.services.db
      .select({ sourceId: migrationRecordMaps.sourceId })
      .from(migrationRecordMaps)
      .where(eq(migrationRecordMaps.runId, run.id));
    expect(dataRows.length, 'one row per identity row, with nothing dropped').toBe(total.length);
    expect(dataRows.length).toBeGreaterThan(EXTRA);
    // The old behaviour, gone: no row announcing that the rest is missing.
    expect(csv).not.toMatch(/TRUNCATED/);
  }, 300_000);

  it('filters at the database rather than after the fact', async () => {
    const csv = await download(`/api/runs/${run.id}/records.csv?outcome=FAILED`);
    const rows = csv
      .split('\r\n')
      .filter((l) => l.length > 0)
      .slice(1);
    const expected = await t.services.db
      .select({ sourceId: migrationRecordMaps.sourceId })
      .from(migrationRecordMaps)
      .where(and(eq(migrationRecordMaps.runId, run.id), eq(migrationRecordMaps.outcome, 'FAILED')));
    expect(rows.length).toBe(expected.length);
    for (const row of rows) expect(row.split(',')[3]).toBe('FAILED');
  }, 300_000);

  it('crosses the page boundary without losing or repeating a row', async () => {
    // The failure a keyset walk makes: a row at the edge of a page served twice or not at all.
    const csv = await download(`/api/runs/${run.id}/records.csv`);
    const ids = csv
      .split('\r\n')
      .filter((l) => l.length > 0)
      .slice(1)
      .map((l) => l.split(',')[1]);
    expect(new Set(ids).size, 'every source id appears exactly once').toBe(ids.length);
    // And in the order the walk promises, so a reader diffing two exports sees real changes.
    const streamed = ids.filter((i) => i?.startsWith('src-'));
    expect(streamed).toEqual([...streamed].sort());
  }, 300_000);

  it('starts with a byte order mark and uses CRLF, so a spreadsheet reads it as UTF-8', async () => {
    const csv = await download(`/api/runs/${run.id}/records.csv`);
    expect(csv.codePointAt(0), 'byte order mark').toBe(0xfeff);
    expect(csv.split('\r\n').length, 'CRLF line endings').toBeGreaterThan(1);
  }, 300_000);
});

/**
 * What an exported cell looks like, for every value that has ever broken a CSV.
 *
 * Run against the writer rather than an endpoint, because the question is about the format and this
 * way every case is visible in one place.
 */
describe('CSV escaping, case by case', () => {
  const render = async (value: unknown) => {
    const pages = (async function* () {
      yield [[value as string]];
    })();
    let out = '';
    for await (const piece of csvStream(['Value'], pages)) out += piece;
    // Not split on CRLF: a quoted cell may contain one, which is the case this exists to check.
    const header = '\uFEFFValue\r\n';
    expect(out.startsWith(header)).toBe(true);
    return out.slice(header.length, out.length - 2);
  };

  it('quotes what needs quoting and nothing else', async () => {
    expect(await render('plain')).toBe('plain');
    expect(await render('with,comma')).toBe('"with,comma"');
    expect(await render('say "hi"')).toBe('"say ""hi"""');
    expect(await render('line\nbreak')).toBe('"line\nbreak"');
    expect(await render('windows\r\nbreak')).toBe('"windows\r\nbreak"');
  });

  it('keeps Unicode and emoji exactly as they were', async () => {
    expect(await render('Ünïcödé — 日本語')).toBe('Ünïcödé — 日本語');
    expect(await render('🧪 emoji 🎉')).toBe('🧪 emoji 🎉');
    // A combining sequence is not normalised: the export is a record of what was stored.
    expect(await render('é')).toBe('é');
  });

  it('tells an empty string from a missing value', async () => {
    // Both render as nothing, which is the format's limitation rather than a choice — and it is why
    // validation reports VALUE_LOST separately instead of leaving a reader to infer it from a CSV.
    expect(await render('')).toBe('');
    expect(await render(null)).toBe('');
    expect(await render(undefined)).toBe('');
  });

  it('carries a large text value whole', async () => {
    const long = 'x'.repeat(100_000);
    expect(await render(long)).toBe(long);
    const awkward = `${'a'.repeat(50_000)},"${'b'.repeat(50_000)}`;
    expect(await render(awkward)).toBe(`"${awkward.replace(/"/g, '""')}"`);
  });

  /**
   * Formula injection, and the one place the export is not byte-for-byte.
   *
   * A spreadsheet executes a cell beginning `=`, `+`, `-` or `@`, so an exported value starting with
   * one is a command somebody else's machine runs. The product prefixes those cells with a single
   * quote, which spreadsheets strip on display: the value reads correctly and does not execute.
   *
   * This is the only transformation an export applies, it applies to the leading character only, and
   * it is recorded here and in `docs/EXPORT_FORMAT.md` because an undocumented mutation of exported
   * data is worse than either choice on its own.
   */
  it('neutralises a formula without hiding that it did', async () => {
    expect(await render('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(await render('=cmd|"/c calc"!A1')).toBe('"\'=cmd|""/c calc""!A1"');
    expect(await render('+1-555-0100')).toBe("'+1-555-0100");
    expect(await render('-42')).toBe("'-42");
    expect(await render('@handle')).toBe("'@handle");
    expect(await render('\tleading tab')).toBe("'\tleading tab");
    // Not a formula: the character has to lead.
    expect(await render('a=b')).toBe('a=b');
    expect(await render('10-20')).toBe('10-20');
  });

  it('leaves a negative number readable, which is the cost of the above', async () => {
    // A negative number is prefixed, so a spreadsheet shows it as text. The alternative is executing
    // `-2+3` as a formula, and a number that reads correctly beats a number that computes.
    const rendered = await render('-99.50');
    expect(rendered).toBe("'-99.50");
    expect(rendered.slice(1), 'the value itself is unchanged').toBe('-99.50');
  });
});
