import { describe, expect, it, vi } from 'vitest';
import type { DataQualityRuleDto, FieldProfileDto, TableProfileDto } from '../../shared/domain';
import type { DvRecord, FieldValue, TableMetadata } from '../../shared/metadata';
import {
  deriveTargetRules,
  DISTINCT_VALUE_CAP,
  evaluateRules,
  FULL_PROFILE_LIMIT,
  MASKED_VALUE,
  ProfilingService,
  PROFILE_PAGE_SIZE,
  ruleKey,
  TOP_VALUES_LIMIT,
  type RuleViolations,
} from '../../server/src/services/profiling-service';
import { attr, table } from './fixtures';

// ---------------------------------------------------------------------------
// A connector over an in-memory array. Only the three read methods profiling is allowed to use
// are implemented; every write method is a spy that also throws, so a write shows up twice.
// ---------------------------------------------------------------------------

class FakeConnector {
  pagesServed = 0;
  requestedColumns: string[] = [];
  readonly createRecord = vi.fn(() => {
    throw new Error('profiling must never write');
  });
  readonly updateRecord = vi.fn(() => {
    throw new Error('profiling must never write');
  });
  readonly findByAlternateKey = vi.fn();
  readonly findByFields = vi.fn();
  readonly retrieveByIds = vi.fn();

  constructor(
    private readonly meta: TableMetadata,
    private readonly records: DvRecord[],
    private readonly approximate = false,
    /** Lets a test claim a table far larger than the fixture it actually streams. */
    private readonly countOverride: number | null = null,
  ) {}

  async getTable(): Promise<TableMetadata> {
    return this.meta;
  }

  async countRecords() {
    return { count: this.countOverride ?? this.records.length, approximate: this.approximate };
  }

  async *queryRecords(_t: TableMetadata, columns: string[], opts: { pageSize: number }) {
    this.requestedColumns = columns;
    for (let i = 0; i < this.records.length; i += opts.pageSize) {
      this.pagesServed++;
      yield this.records.slice(i, i + opts.pageSize);
    }
  }
}

const ctx = {
  userId: 'u1',
  organizationId: 'o1',
  role: 'ADMIN' as const,
  isDemoOrg: false,
  displayName: 'Tester',
  requestId: 'req-1',
  platformOperator: false,
};

function service(conn: FakeConnector) {
  return new ProfilingService(
    {} as any,
    { getAccessible: async () => ({ id: 'env-1' }) } as any,
    { getTable: async (_env: string, c: any, name: string) => c.getTable(name) } as any,
    { connectorFor: async () => conn } as any,
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
  );
}

/** Builds records whose values come from one column of sample data. */
function rows(field: string, values: FieldValue[], prefix = 'r'): DvRecord[] {
  return values.map((v, i) => ({ id: `${prefix}${i}`, values: { [field]: v } }));
}

async function profile(
  meta: TableMetadata,
  records: DvRecord[],
  input: Partial<Parameters<ProfilingService['profileTable']>[1]> = {},
  approximate = false,
  countOverride: number | null = null,
): Promise<{ result: TableProfileDto; conn: FakeConnector }> {
  const conn = new FakeConnector(meta, records, approximate, countOverride);
  const result = await service(conn).profileTable(ctx, {
    environmentId: 'env-1',
    table: meta.logicalName,
    ...input,
  });
  return { result, conn };
}

const field = (p: TableProfileDto, name: string): FieldProfileDto => {
  const f = p.fields.find((x) => x.field === name);
  if (!f) throw new Error(`no profile for ${name}`);
  return f;
};

// ---------------------------------------------------------------------------

describe('value shapes, counted in records', () => {
  it('counts money written as text in a column that is mostly plain numbers', async () => {
    /*
     * The credit_limit column from the certified fixture: every fifth row carries a written amount
     * and the rest are bare. The semantic reader calls this column nothing, because four fifths of
     * the sample has to agree before it will; the per-record count is what makes it reportable.
     */
    const values = Array.from({ length: 60 }, (_, i) =>
      i % 5 === 0 ? `$1,${200 + i}.50` : `${1000 + i * 7}`,
    );
    const meta = table('account', [attr('credit_limit', 'String')]);
    const { result } = await profile(meta, rows('credit_limit', values));
    const c = field(result, 'credit_limit').conversion!;

    expect(c.populated).toBe(60);
    expect(c.currency, 'every fifth of sixty').toBe(12);
    expect(c.numbers).toBe(48);
    expect(c.text).toBe(0);
    expect(c.currencyMarkers, 'one currency throughout').toEqual(['$']);
    expect(c.decimalSeparators, 'one decimal convention').toEqual(['dot']);
    expect(c.maxDecimals).toBe(2);
    expect(c.overTwoDecimals).toBe(0);
  });

  it('notices when one column writes money two different ways', async () => {
    const meta = table('account', [attr('amount', 'String')]);
    const { result } = await profile(meta, rows('amount', ['$1,200.50', '1.234,56', '$9.99']));
    const c = field(result, 'amount').conversion!;
    expect(c.currency).toBe(3);
    // $1,200.50 and $9.99 are one convention -- the second simply has nothing to group. The
    // ambiguity worth reporting is 1.234,56, which puts the comma where the others put the dot.
    expect(c.decimalSeparators.sort()).toEqual(['comma', 'dot']);
  });

  it('counts boolean spellings and decimal places', async () => {
    const meta = table('account', [attr('active', 'String')]);
    const { result } = await profile(meta, rows('active', ['Yes', 'no', 'TRUE', 'y', 'Yes']));
    const c = field(result, 'active').conversion!;
    expect(c.booleans).toBe(5);
    expect(c.booleanSpellings).toEqual(['no', 'true', 'y', 'yes']);

    const meta2 = table('account', [attr('rate', 'String')]);
    const { result: r2 } = await profile(meta2, rows('rate', ['0.12345', '1.5', '2', '0.987654']));
    const c2 = field(r2, 'rate').conversion!;
    expect(c2.maxDecimals).toBe(6);
    expect(c2.overTwoDecimals, 'two of the four').toBe(2);
  });

  it('reports the spellings a boolean column had before inference normalised them', async () => {
    /*
     * By the time the profiler sees a Boolean column the values are already true and false, so the
     * four ways the source spelled them are carried from where they still existed. Without this the
     * product would read Yes/no/TRUE/y, understand all four, and report nothing -- while the target
     * takes one convention and a loader written for one spelling reads the rest as false.
     */
    const meta = table('account', [
      attr('active', 'Boolean', { sourceSpellings: ['yes', 'no', 'true', 'y'] }),
    ]);
    const { result } = await profile(meta, rows('active', [true, false, true, false]));
    const c = field(result, 'active').conversion!;
    expect(c.booleanSpellings).toEqual(['no', 'true', 'y', 'yes']);
    expect(c.booleans, 'every populated record is one of them').toBe(4);
  });

  it('shows no example values for a secured column', async () => {
    const meta = table('account', [attr('secret', 'String', { isSecured: true })]);
    const { result } = await profile(meta, rows('secret', ['$1,200.50', '$2.00']));
    const c = field(result, 'secret').conversion!;
    expect(c.currency, 'the counts are still true').toBe(2);
    expect(c.samples).toEqual([]);
  });
});

describe('collision arithmetic, proven against the rows that produced it', () => {
  /*
   * The numbers a reader is asked to act on. Three of them are easy to confuse and all three are
   * reported, so each is asserted against a fixture whose contents can be counted by hand.
   */
  it('separates duplicate groups from rows in collision from excess rows', async () => {
    // Sixty customer numbers where the last twelve repeat the first twelve: the double-export shape.
    const values = Array.from({ length: 60 }, (_, i) =>
      i < 48 ? `CUST-${1000 + i}` : `CUST-${1000 + (i - 48)}`,
    );
    const meta = table('account', [attr('customer_number', 'String')]);
    const { result } = await profile(meta, rows('customer_number', values));
    const d = field(result, 'customer_number').duplication!;

    expect(d.examined).toBe(60);
    expect(d.distinctValues, '48 numbers appear at all').toBe(48);
    expect(d.duplicateGroups, '12 of them are held twice').toBe(12);
    expect(d.rowsInCollision, 'those 12 groups account for 24 records').toBe(24);
    expect(d.largestGroup).toBe(2);
    expect(d.nullOrBlank).toBe(0);
    expect(d.truncated).toBe(false);
    // The pre-existing count means something different again: rows beyond one per value.
    expect(field(result, 'customer_number').duplicateCount).toBe(12);
  });

  it('names the records that collide, so the reader can go and look', async () => {
    const meta = table('account', [attr('code', 'String')]);
    const { result } = await profile(meta, rows('code', ['A', 'B', 'A', 'C', 'A']));
    const d = field(result, 'code').duplication!;
    expect(d.duplicateGroups).toBe(1);
    expect(d.rowsInCollision).toBe(3);
    expect(d.largestGroup).toBe(3);
    expect(d.examples[0].value).toBe('A');
    expect(d.examples[0].count).toBe(3);
    expect(d.examples[0].recordIds, 'rows 0, 2 and 4 hold it').toEqual(['r0', 'r2', 'r4']);
  });

  it('does not count an absent value as a repeated one', async () => {
    /*
     * Three records with nothing in the column is a completeness problem with a different remedy.
     * Folding them into the duplicate count would report one missing code as evidence that codes
     * repeat.
     */
    const meta = table('account', [attr('code', 'String')]);
    const { result } = await profile(meta, rows('code', ['A', 'A', '', '  ', null]));
    const d = field(result, 'code').duplication!;
    expect(d.distinctValues, 'only A is a value').toBe(1);
    expect(d.duplicateGroups).toBe(1);
    expect(d.rowsInCollision).toBe(2);
    expect(d.nullOrBlank, 'two blanks and a null').toBe(3);
  });

  it('names no records for a secured column, because the values are indistinguishable once masked', async () => {
    const meta = table('account', [attr('ssn', 'String', { isSecured: true })]);
    const { result } = await profile(meta, rows('ssn', ['X', 'X', 'Y']));
    const d = field(result, 'ssn').duplication!;
    expect(d.duplicateGroups).toBe(1);
    expect(d.examples[0].value).toBe(MASKED_VALUE);
    expect(d.examples[0].recordIds).toEqual([]);
  });
});

describe('profiling basis', () => {
  const meta = table('account', [attr('code', 'String')]);

  it('reports EXACT only when every record was examined', async () => {
    const { result } = await profile(meta, rows('code', ['a', 'b', 'c']));
    expect(result.basis).toBe('EXACT');
    expect(result.examined).toBe(3);
    expect(result.totalRecords).toBe(3);
    expect(field(result, 'code').basis).toBe('EXACT');
  });

  it('reports SAMPLED when the sample stops short of the table', async () => {
    const { result, conn } = await profile(meta, rows('code', ['a', 'b', 'c', 'd', 'e']), { sampleSize: 2 });
    expect(result.basis).toBe('SAMPLED');
    expect(result.examined).toBe(2);
    expect(result.totalRecords).toBe(5);
    // Streaming stops as soon as the sample is complete: one page, never the whole table.
    expect(conn.pagesServed).toBe(1);
  });

  it('never claims EXACT when the total itself is only an estimate', async () => {
    const { result } = await profile(meta, rows('code', ['a', 'b']), {}, true);
    expect(result.examined).toBe(2);
    expect(result.totalApproximate).toBe(true);
    expect(result.basis).toBe('SAMPLED');
  });

  it('honours a full profile for a small table', async () => {
    const { result } = await profile(meta, rows('code', ['a', 'b', 'c']), { full: true, sampleSize: 1 });
    expect(result.examined).toBe(3);
    expect(result.basis).toBe('EXACT');
  });

  it('falls back to sampling, and says so, when a full profile is too large', async () => {
    // The table claims more records than FULL_PROFILE_LIMIT, so `full` cannot be honoured.
    const { result } = await profile(
      meta,
      rows('code', ['a', 'b', 'c', 'd']),
      { full: true, sampleSize: 3 },
      false,
      FULL_PROFILE_LIMIT + 1,
    );
    expect(result.totalRecords).toBe(FULL_PROFILE_LIMIT + 1);
    expect(result.examined).toBe(3);
    expect(result.basis).toBe('SAMPLED');
    expect(field(result, 'code').basis).toBe('SAMPLED');
  });
});

describe('field statistics', () => {
  it('counts nulls, blanks and surrounding whitespace', async () => {
    const meta = table('account', [attr('code', 'String')]);
    const { result } = await profile(meta, rows('code', ['a', '', '   ', ' b ', null, 'c']));
    const f = field(result, 'code');
    expect(f.examined).toBe(6);
    expect(f.nullCount).toBe(1);
    expect(f.nullPercent).toBeCloseTo(16.7, 1);
    expect(f.blankCount).toBe(2);
    expect(f.whitespaceCount).toBe(1);
    expect(f.minLength).toBe(0);
    expect(f.maxLength).toBe(3);
    expect(f.averageLength).toBeCloseTo(1.6, 1);
  });

  it('counts distinct and duplicate values', async () => {
    const meta = table('account', [attr('code', 'String')]);
    const { result } = await profile(meta, rows('code', ['a', 'b', 'a', 'a', null, 'c']));
    const f = field(result, 'code');
    expect(f.distinctCount).toBe(3);
    expect(f.duplicateCount).toBe(2); // 5 non-null values over 3 distinct
  });

  it('reports unknown rather than wrong once the distinct cap is passed', async () => {
    const meta = table('account', [attr('code', 'String')]);
    const values = Array.from({ length: DISTINCT_VALUE_CAP + 10 }, (_, i) => `v${i}`);
    const { result } = await profile(meta, rows('code', values), { sampleSize: values.length });
    const f = field(result, 'code');
    expect(f.examined).toBe(values.length);
    expect(f.distinctCount).toBeNull();
    expect(f.duplicateCount).toBeNull();
    expect(f.topValuesTruncated).toBe(true);
  });

  it('computes numeric statistics and the largest scale seen', async () => {
    const meta = table('account', [attr('amount', 'Decimal', { precision: 2 })]);
    const { result } = await profile(meta, rows('amount', [1.5, 2.25, 10, null]));
    const f = field(result, 'amount');
    expect(f.minValue).toBe(1.5);
    expect(f.maxValue).toBe(10);
    expect(f.averageValue).toBeCloseTo(4.583333, 5);
    expect(f.maxScale).toBe(2);
    expect(f.invalidValueCount).toBe(0);
  });

  it('counts values that cannot be read as the column type', async () => {
    const meta = table('account', [attr('amount', 'Integer')]);
    const { result } = await profile(meta, rows('amount', [1, 'abc', 3]));
    expect(field(result, 'amount').invalidValueCount).toBe(1);
  });

  it('records the date range and counts unparseable dates', async () => {
    const meta = table('account', [attr('when', 'DateTime')]);
    const { result } = await profile(
      meta,
      rows('when', ['2024-01-02T00:00:00Z', 'not-a-date', '2023-05-06T10:00:00Z', null]),
    );
    const f = field(result, 'when');
    expect(f.minDate).toBe('2023-05-06T10:00:00.000Z');
    expect(f.maxDate).toBe('2024-01-02T00:00:00.000Z');
    expect(f.invalidDateCount).toBe(1);
    expect(f.invalidValueCount).toBe(1);
  });

  it('profiles a lookup by its id', async () => {
    const meta = table('contact', [attr('accountid', 'Lookup', { targets: ['account'] })]);
    const { result } = await profile(meta, [
      { id: 'r0', values: { accountid: { id: 'a-1', logicalName: 'account' } } },
      { id: 'r1', values: { accountid: { id: 'a-1', logicalName: 'account' } } },
      { id: 'r2', values: { accountid: null } },
    ]);
    const f = field(result, 'accountid');
    expect(f.nullCount).toBe(1);
    expect(f.distinctCount).toBe(1);
    expect(f.topValues).toEqual([{ value: 'a-1', count: 2 }]);
  });
});

describe('top values', () => {
  it('orders by frequency', async () => {
    const meta = table('account', [attr('status', 'String')]);
    const { result } = await profile(meta, rows('status', ['A', 'B', 'A', 'C', 'A', 'B']));
    const f = field(result, 'status');
    expect(f.topValues).toEqual([
      { value: 'A', count: 3 },
      { value: 'B', count: 2 },
      { value: 'C', count: 1 },
    ]);
    expect(f.topValuesTruncated).toBe(false);
  });

  it('truncates and flags when there are more distinct values than the cap', async () => {
    const meta = table('account', [attr('status', 'String')]);
    const values = Array.from({ length: TOP_VALUES_LIMIT + 5 }, (_, i) => `s${i}`);
    const { result } = await profile(meta, rows('status', values));
    const f = field(result, 'status');
    expect(f.topValues).toHaveLength(TOP_VALUES_LIMIT);
    expect(f.topValuesTruncated).toBe(true);
  });

  it('masks a secured column in top values and in issue samples, keeping the counts', async () => {
    const meta = table('employee', [attr('ssn', 'String', { isSecured: true, maxLength: 20 })]);
    const rules: DataQualityRuleDto[] = [
      { kind: 'MAX_LENGTH', field: 'ssn', max: 2, origin: 'TARGET_SCHEMA', severity: 'BLOCKER' },
    ];
    const { result } = await profile(meta, rows('ssn', ['111', '111', '222']), { rules });
    const f = field(result, 'ssn');
    expect(f.topValues).toEqual([
      { value: MASKED_VALUE, count: 2 },
      { value: MASKED_VALUE, count: 1 },
    ]);
    const issue = f.issues.find((i) => i.code === 'STRING_TOO_LONG');
    expect(issue?.affected).toBe(3);
    expect(issue?.samples?.every((s) => s.value === MASKED_VALUE)).toBe(true);
  });
});

describe('table-level statistics', () => {
  it('counts missing and repeated primary keys', async () => {
    const meta = table('account', [attr('code', 'String')]);
    const { result } = await profile(meta, [
      { id: 'r0', values: { accountid: 'k1', code: 'a' } },
      { id: 'r1', values: { accountid: 'k1', code: 'b' } },
      { id: 'r2', values: { accountid: '  ', code: 'c' } },
    ]);
    expect(result.primaryKeyField).toBe('accountid');
    expect(result.duplicateKeyCount).toBe(1);
    expect(result.primaryKeyMissing).toBe(1);
    expect(result.issues.map((i) => i.code).sort()).toEqual(['DUPLICATE_KEY', 'PRIMARY_KEY_MISSING']);
    expect(result.issues.every((i) => i.basis === 'EXACT')).toBe(true);
    expect(result.columns).toBe(result.fields.length);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(result.profiledAt)).not.toBeNaN();
  });

  it('skips system-managed columns unless they are asked for by name', async () => {
    const meta = table('account', [attr('code', 'String'), attr('createdon', 'DateTime')]);
    const { result } = await profile(meta, rows('code', ['a']));
    expect(result.fields.map((f) => f.field)).not.toContain('createdon');

    const { result: explicit } = await profile(meta, rows('code', ['a']), { fields: ['createdon'] });
    expect(explicit.fields.map((f) => f.field)).toEqual(['createdon']);
  });

  it('skips columns that cannot be read', async () => {
    const meta = table('account', [
      attr('code', 'String'),
      attr('secret', 'String', { isValidForRead: false }),
    ]);
    const { result } = await profile(meta, rows('code', ['a']));
    expect(result.fields.map((f) => f.field)).not.toContain('secret');
  });
});

describe('single field profiling', () => {
  it('uses the same accumulator as a table profile', async () => {
    const meta = table('account', [attr('code', 'String'), attr('other', 'String')]);
    const records = rows('code', ['a', '', null, 'a']);
    const conn = new FakeConnector(meta, records);
    const one = await service(conn).profileField(ctx, {
      environmentId: 'env-1',
      table: 'account',
      field: 'code',
    });
    const { result } = await profile(meta, records);
    expect(one).toEqual(field(result, 'code'));
    expect(one.nullCount).toBe(1);
    expect(one.blankCount).toBe(1);
  });
});

describe('profiling is read-only', () => {
  it('never calls a write method', async () => {
    const meta = table('account', [attr('code', 'String')]);
    const rules: DataQualityRuleDto[] = [
      { kind: 'REQUIRED', field: 'code', origin: 'TARGET_SCHEMA', severity: 'BLOCKER' },
    ];
    const { conn } = await profile(meta, rows('code', ['a', null, 'b']), { rules, full: true });
    expect(conn.createRecord).not.toHaveBeenCalled();
    expect(conn.updateRecord).not.toHaveBeenCalled();
    expect(conn.findByAlternateKey).not.toHaveBeenCalled();
    expect(conn.findByFields).not.toHaveBeenCalled();
    expect(conn.retrieveByIds).not.toHaveBeenCalled();
    expect(conn.requestedColumns).toContain('accountid');
  });

  it('reads in pages rather than loading the table', async () => {
    const meta = table('account', [attr('code', 'String')]);
    const values = Array.from({ length: PROFILE_PAGE_SIZE * 3 }, (_, i) => `v${i % 7}`);
    const { result, conn } = await profile(meta, rows('code', values), { full: true });
    expect(conn.pagesServed).toBe(3);
    expect(result.examined).toBe(values.length);
  });
});

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe('deriveTargetRules', () => {
  const target = table('contact', [
    attr('fullname', 'String', { requiredLevel: 'ApplicationRequired', maxLength: 160 }),
    attr('emailaddress', 'String', { format: 'Email' }),
    attr('score', 'Integer', { minValue: 0, maxValue: 100 }),
    attr('note', 'Memo'),
  ]);
  const mappings = [
    { sourceField: 'NAME', targetField: 'fullname' },
    { sourceField: 'EMAIL', targetField: 'emailaddress' },
    { sourceField: 'SCORE', targetField: 'score' },
    { sourceField: 'NOTE', targetField: 'note' },
    { sourceField: 'GHOST', targetField: 'does_not_exist' },
  ];

  it('states the target constraints against the source fields', () => {
    const rules = deriveTargetRules(target, mappings);
    expect(rules).toEqual([
      { kind: 'REQUIRED', field: 'NAME', origin: 'TARGET_SCHEMA', severity: 'BLOCKER' },
      { kind: 'MAX_LENGTH', field: 'NAME', max: 160, origin: 'TARGET_SCHEMA', severity: 'BLOCKER' },
      { kind: 'VALID_EMAIL', field: 'EMAIL', origin: 'TARGET_SCHEMA', severity: 'WARNING' },
      {
        kind: 'NUMERIC_RANGE',
        field: 'SCORE',
        min: 0,
        max: 100,
        origin: 'TARGET_SCHEMA',
        severity: 'BLOCKER',
      },
    ]);
  });

  it('produces nothing for an unmapped or unconstrained column', () => {
    expect(deriveTargetRules(target, [{ sourceField: 'NOTE', targetField: 'note' }])).toEqual([]);
    expect(deriveTargetRules(target, [])).toEqual([]);
  });
});

function baseProfile(overrides: Partial<FieldProfileDto> = {}): FieldProfileDto {
  return {
    field: 'NAME',
    displayName: 'NAME',
    type: 'String',
    targetField: 'fullname',
    basis: 'EXACT',
    examined: 1000,
    nullCount: 0,
    nullPercent: 0,
    blankCount: 0,
    distinctCount: 1000,
    duplicateCount: 0,
    minLength: 1,
    maxLength: 204,
    averageLength: 40,
    whitespaceCount: 0,
    minValue: null,
    maxValue: null,
    averageValue: null,
    maxScale: null,
    minDate: null,
    maxDate: null,
    invalidDateCount: 0,
    invalidEmailCount: 0,
    invalidValueCount: 0,
    topValues: [],
    topValuesTruncated: false,
    issues: [],
    ...overrides,
  };
}

describe('evaluateRules', () => {
  const required: DataQualityRuleDto = {
    kind: 'REQUIRED',
    field: 'NAME',
    origin: 'TARGET_SCHEMA',
    severity: 'BLOCKER',
  };
  const maxLength: DataQualityRuleDto = {
    kind: 'MAX_LENGTH',
    field: 'NAME',
    max: 160,
    origin: 'TARGET_SCHEMA',
    severity: 'BLOCKER',
  };

  it('turns missing values into REQUIRED_VALUE_MISSING', () => {
    const issues = evaluateRules(baseProfile({ nullCount: 5, blankCount: 2 }), [required]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'REQUIRED_VALUE_MISSING',
      severity: 'BLOCKER',
      field: 'NAME',
      affected: 7,
      basis: 'EXACT',
    });
    expect(issues[0].resolution).toBeTruthy();
  });

  it('reads as English whether one record is affected or many', () => {
    // The noun was pluralised and the verb was not, so a finding about a single record read
    // "1 record have no value for NAME". These sentences are the product explaining somebody's own
    // data back to them, which is exactly where a slip is noticed.
    const [one] = evaluateRules(baseProfile({ nullCount: 1 }), [required]);
    expect(one.message).toContain('1 record has no value');
    expect(one.message).not.toContain('record have');

    const [many] = evaluateRules(baseProfile({ nullCount: 4 }), [required]);
    expect(many.message).toContain('4 records have no value');

    const [dupe] = evaluateRules(baseProfile({ duplicateCount: 1 }), [
      { kind: 'UNIQUE', field: 'NAME', origin: 'TARGET_SCHEMA', severity: 'BLOCKER' },
    ]);
    expect(dupe.message).toContain('1 record repeats');
  });

  it('says nothing when the data satisfies the rule', () => {
    expect(evaluateRules(baseProfile({ maxLength: 12 }), [required, maxLength])).toEqual([]);
  });

  it('reports the exact number of over-long values when profiling counted them', () => {
    const violations: RuleViolations = new Map([
      [ruleKey(maxLength), { count: 38, samples: [{ recordId: 'r1', value: 'x'.repeat(204) }] }],
    ]);
    const [issue] = evaluateRules(baseProfile(), [maxLength], violations);
    expect(issue).toMatchObject({ code: 'STRING_TOO_LONG', affected: 38, basis: 'EXACT' });
    expect(issue.message).toContain('38');
    expect(issue.samples).toHaveLength(1);
  });

  it('does not invent a count when profiling did not measure one', () => {
    const [issue] = evaluateRules(baseProfile(), [maxLength]);
    expect(issue.code).toBe('STRING_TOO_LONG');
    expect(issue.affected).toBe(0);
    expect(issue.message).toMatch(/not counted/);
  });

  it('carries a sampled basis into every issue so a sample never reads as a total', () => {
    const issues = evaluateRules(baseProfile({ basis: 'SAMPLED', nullCount: 3 }), [required]);
    expect(issues[0].basis).toBe('SAMPLED');
    expect(issues[0].message).toContain('examined record');
  });

  it('turns repeated values into DUPLICATE_KEY, and stays silent when the count is unknown', () => {
    const unique: DataQualityRuleDto = {
      kind: 'UNIQUE',
      field: 'NAME',
      origin: 'MAPPING',
      severity: 'BLOCKER',
    };
    expect(evaluateRules(baseProfile({ duplicateCount: 4 }), [unique])[0]).toMatchObject({
      code: 'DUPLICATE_KEY',
      affected: 4,
    });
    expect(evaluateRules(baseProfile({ duplicateCount: null }), [unique])).toEqual([]);
  });

  it('ignores rules stated against another field', () => {
    expect(evaluateRules(baseProfile({ nullCount: 5 }), [{ ...required, field: 'OTHER' }])).toEqual([]);
  });
});

describe('rules counted while streaming', () => {
  it('produces exact counts from the target schema', async () => {
    const source = table('customer', [attr('NAME', 'String'), attr('EMAIL', 'String')]);
    const target = table('contact', [
      attr('fullname', 'String', { requiredLevel: 'ApplicationRequired', maxLength: 5 }),
      attr('emailaddress', 'String', { format: 'Email' }),
    ]);
    const rules = deriveTargetRules(target, [
      { sourceField: 'NAME', targetField: 'fullname' },
      { sourceField: 'EMAIL', targetField: 'emailaddress' },
    ]);
    const records: DvRecord[] = [
      { id: 'r0', values: { NAME: 'Alice', EMAIL: 'alice@example.com' } },
      { id: 'r1', values: { NAME: 'Bartholomew', EMAIL: 'not-an-email' } },
      { id: 'r2', values: { NAME: null, EMAIL: 'carol@example.com' } },
      { id: 'r3', values: { NAME: '   ', EMAIL: null } },
      { id: 'r4', values: { NAME: 'Christopher', EMAIL: 'dave@example' } },
    ];
    const { result } = await profile(source, records, { rules, full: true });
    expect(result.basis).toBe('EXACT');

    const name = field(result, 'NAME');
    const missing = name.issues.find((i) => i.code === 'REQUIRED_VALUE_MISSING');
    expect(missing).toMatchObject({ affected: 2, severity: 'BLOCKER', basis: 'EXACT' });
    const tooLong = name.issues.find((i) => i.code === 'STRING_TOO_LONG');
    expect(tooLong).toMatchObject({ affected: 2, basis: 'EXACT' });
    expect(tooLong?.samples?.map((s) => s.value)).toEqual(['Bartholomew', 'Christopher']);

    const email = field(result, 'EMAIL');
    const invalid = email.issues.find((i) => i.code === 'INVALID_EMAIL');
    expect(invalid).toMatchObject({ affected: 2, severity: 'WARNING' });
  });
});
