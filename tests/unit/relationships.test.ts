import { describe, expect, it } from 'vitest';
import type { FieldProfileDto, TableProfileDto, ValueFrequencyDto } from '../../shared/domain';
import { discoverRelationships, relationshipFindings } from '../../shared/relationships';

/**
 * Relationships found in the data, and the line between "found" and "guessed".
 *
 * The classification is the feature. Acting on a relationship means choosing a migration order and
 * treating unmatched values as broken references, so a reader who cannot tell a declared edge from
 * a plausible one will act on both the same way — and be wrong about one of them.
 */

const sample = (values: Array<[string, number]>, truncated = false) => ({
  values: values.map(([value, count]) => ({ value, count })) as ValueFrequencyDto[],
  truncated,
});

const field = (over: Partial<FieldProfileDto> & { field: string }): FieldProfileDto => ({
  displayName: over.field,
  type: 'String',
  basis: 'EXACT',
  examined: 10,
  nullCount: 0,
  nullPercent: 0,
  blankCount: 0,
  distinctCount: 10,
  duplicateCount: 0,
  minLength: null,
  maxLength: null,
  averageLength: null,
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
  ...over,
});

const tbl = (table: string, fields: FieldProfileDto[], examined = 10): TableProfileDto => ({
  environmentId: 'env',
  table,
  displayName: table,
  basis: 'EXACT',
  totalRecords: examined,
  totalApproximate: false,
  examined,
  columns: fields.length,
  primaryKeyField: null,
  primaryKeyMissing: 0,
  duplicateKeyCount: 0,
  fields,
  issues: [],
  profiledAt: '2026-10-09T00:00:00.000Z',
  durationMs: 1,
});

/** Customers with three numbers; orders referencing them. */
const customers = (
  values: Array<[string, number]> = [
    ['C1', 1],
    ['C2', 1],
    ['C3', 1],
  ],
) =>
  tbl(
    'customers',
    [
      field({
        field: 'customer_number',
        examined: values.length,
        distinctCount: values.length,
        valueSample: sample(values),
      }),
    ],
    values.length,
  );

const orders = (values: Array<[string, number]>) =>
  tbl(
    'orders',
    [
      field({
        field: 'customer_number',
        examined: values.reduce((n, [, c]) => n + c, 0),
        distinctCount: values.length,
        valueSample: sample(values),
      }),
    ],
    values.reduce((n, [, c]) => n + c, 0),
  );

describe('finding the edges nobody wrote down', () => {
  it('infers a relationship when names, types, uniqueness and values all agree', () => {
    const found = discoverRelationships([
      {
        dataset: 'Export.xlsx',
        profile: orders([
          ['C1', 4],
          ['C2', 6],
        ]),
      },
      { dataset: 'Export.xlsx', profile: customers() },
    ]);
    const edge = found.find((r) => r.childTable === 'orders' && r.parentTable === 'customers');
    expect(edge, 'orders.customer_number -> customers.customer_number').toBeTruthy();
    expect(edge!.confidence).toBe('INFERRED');
    expect(edge!.coverage).toBe(1);
    expect(edge!.orphanRecords).toBe(0);
  });

  it('counts orphans in records, not in values', () => {
    // C9 is unknown and ten orders carry it. The number a person needs is ten, not one.
    const found = discoverRelationships([
      {
        dataset: 'Export.xlsx',
        profile: orders([
          ['C1', 4],
          ['C9', 10],
        ]),
      },
      { dataset: 'Export.xlsx', profile: customers() },
    ]);
    const edge = found.find((r) => r.childTable === 'orders')!;
    expect(edge.orphanRecords).toBe(10);
    expect(edge.orphanValues).toEqual(['C9']);
    expect(edge.coverage).toBe(0.5);
    expect(edge.confidence, 'half the values are unknown -- not something to rely on').toBe('REVIEW');
  });

  it('will not infer from a truncated sample, because a missing value is not a broken reference', () => {
    const found = discoverRelationships([
      {
        dataset: 'Export.xlsx',
        profile: orders([
          ['C1', 1],
          ['C2', 1],
        ]),
      },
      {
        dataset: 'Export.xlsx',
        profile: tbl('customers', [
          field({
            field: 'customer_number',
            valueSample: sample(
              [
                ['C1', 1],
                ['C2', 1],
              ],
              true,
            ),
          }),
        ]),
      },
    ]);
    const edge = found.find((r) => r.childTable === 'orders')!;
    expect(edge.estimated).toBe(true);
    expect(edge.confidence).toBe('REVIEW');
    expect(edge.evidence.join(' ')).toContain('lower bound');
  });

  it('is promoted to declared when the source says the tables are related', () => {
    const found = discoverRelationships([
      { dataset: 'CRM', profile: orders([['C1', 1]]), declaredTables: ['customers'] },
      { dataset: 'CRM', profile: customers() },
    ]);
    expect(found.find((r) => r.childTable === 'orders')!.confidence).toBe('DECLARED');
  });

  it('does not relate two columns that merely share values', () => {
    // Both hold the same codes, and nothing about the names suggests a reference.
    const found = discoverRelationships([
      {
        dataset: 'X',
        profile: tbl('alpha', [field({ field: 'region_code', valueSample: sample([['C1', 1]]) })]),
      },
      {
        dataset: 'X',
        profile: tbl('beta', [field({ field: 'status_code', valueSample: sample([['C1', 1]]) })]),
      },
    ]);
    expect(found).toHaveLength(0);
  });

  it('will not point at a parent column that does not identify one record', () => {
    const found = discoverRelationships([
      { dataset: 'X', profile: orders([['C1', 1]]) },
      {
        dataset: 'X',
        profile: tbl('customers', [
          // Repeats, so a child value does not pick out one parent.
          field({
            field: 'customer_number',
            examined: 4,
            distinctCount: 2,
            valueSample: sample([
              ['C1', 2],
              ['C2', 2],
            ]),
          }),
        ]),
      },
    ]);
    expect(found).toHaveLength(0);
  });

  it('finds nothing in a project with one dataset, because there is nothing to reference', () => {
    expect(discoverRelationships([{ dataset: 'X', profile: customers() }])).toHaveLength(0);
  });
});

describe('what a reader is told about a relationship', () => {
  it('never calls an inferred relationship a foreign key, and does not deduct for finding one', () => {
    const findings = relationshipFindings([
      {
        dataset: 'Export.xlsx',
        profile: orders([
          ['C1', 4],
          ['C2', 6],
        ]),
      },
      { dataset: 'Export.xlsx', profile: customers() },
    ]);
    const rel = findings.find((f) => f.id.startsWith('RELATIONSHIP:'))!;
    expect(rel.title).toContain('inferred from the data');
    expect(rel.evidence.join(' ')).toContain('Not a declared foreign key');
    expect(rel.deducts, 'discovering a relationship is good news').toBe(false);
    expect(rel.severity).toBe('INFO');
  });

  it('raises a warning for records whose parent is missing, and says what to do', () => {
    const findings = relationshipFindings([
      {
        dataset: 'Export.xlsx',
        profile: orders([
          ['C1', 80],
          ['C9', 10],
        ]),
      },
      { dataset: 'Export.xlsx', profile: customers() },
    ]);
    const orphan = findings.find((f) => f.id.startsWith('ORPHAN_REFERENCES:'))!;
    expect(orphan.severity).toBe('WARNING');
    expect(orphan.affected, 'records, not values').toBe(10);
    expect(orphan.summary).toContain('10 records');
    expect(orphan.evidence.join(' ')).toContain('C9');
    expect(orphan.recommendation).toBeTruthy();
    // The reader is told the edge itself is inferred, so they can check it before acting.
    expect(orphan.evidence.join(' ')).toContain('inferred from the data');
  });

  it('does not claim orphans when the comparison was incomplete', () => {
    const findings = relationshipFindings([
      {
        dataset: 'X',
        profile: orders([
          ['C1', 1],
          ['C9', 5],
        ]),
      },
      {
        dataset: 'X',
        profile: tbl('customers', [
          field({ field: 'customer_number', valueSample: sample([['C1', 1]], true) }),
        ]),
      },
    ]);
    expect(findings.filter((f) => f.id.startsWith('ORPHAN_REFERENCES:'))).toHaveLength(0);
  });
});
