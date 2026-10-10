import { describe, expect, it } from 'vitest';
import type { FieldProfileDto, TableProfileDto } from '../../shared/domain';
import type { AttributeMeta } from '../../shared/metadata';
import { findingsForTable, type Finding } from '../../shared/findings';
import { assessReadiness, executiveSummary } from '../../shared/analysis-readiness';

/**
 * Findings, which are the difference between a profile and a product.
 *
 * Profiling already produced `46 nulls` and `42 distinct values`. Every one of those is true and none is a
 * decision, so in practice nobody read them. These cases are about the rules that turn a measurement into
 * something a person can act on — and, just as much, about the measurements that deliberately produce
 * nothing, because a list of eighty weak observations is read with the same attention as a list of none.
 */

const field = (over: Partial<FieldProfileDto> & { field: string }): FieldProfileDto => ({
  displayName: over.field,
  type: 'String',
  basis: 'EXACT',
  examined: 1000,
  nullCount: 0,
  nullPercent: 0,
  blankCount: 0,
  distinctCount: 1000,
  duplicateCount: 0,
  minLength: 5,
  maxLength: 10,
  averageLength: 7,
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

const profile = (fields: FieldProfileDto[], over: Partial<TableProfileDto> = {}): TableProfileDto => ({
  environmentId: 'env',
  table: 'customer',
  displayName: 'Customer',
  basis: 'EXACT',
  totalRecords: 1000,
  totalApproximate: false,
  examined: 1000,
  columns: fields.length,
  primaryKeyField: null,
  primaryKeyMissing: 0,
  duplicateKeyCount: 0,
  fields,
  issues: [],
  profiledAt: '2026-10-04T00:00:00.000Z',
  durationMs: 10,
  ...over,
});

const attribute = (logicalName: string, over: Partial<AttributeMeta> = {}): AttributeMeta => ({
  logicalName,
  schemaName: logicalName,
  displayName: logicalName,
  type: 'String',
  rawType: 'string',
  requiredLevel: 'None',
  isPrimaryId: false,
  isPrimaryName: false,
  isCustom: true,
  isValidForCreate: true,
  isValidForUpdate: true,
  isValidForRead: true,
  ...over,
});

const run = (
  fields: FieldProfileDto[],
  attributes: AttributeMeta[] = [],
  over: Partial<TableProfileDto> = {},
) => findingsForTable({ dataset: 'Legacy CRM', profile: profile(fields, over), attributes });

const byRule = (findings: Finding[], fragment: string) => findings.filter((f) => f.id.includes(fragment));
const titles = (findings: Finding[]) => findings.map((f) => f.title);

describe('findings that have to be arithmetically true, not merely plausible', () => {
  /*
   * Both of these were found by reading a report the product produced on a deliberately messy
   * workbook and checking its numbers against the file that generated it. Both were wrong in the
   * direction that matters: they understated a problem, and they did it confidently.
   */

  it('counts invalid addresses in records, not in spellings of wrong', () => {
    // One bad address repeated across 400 of 1000 records. The semantic reader sees ONE distinct
    // bad value, because it works from a distinct sample; the person cleaning the data sees 400.
    const findings = run(
      [field({ field: 'email', distinctCount: 601, invalidEmailCount: 400 })],
      [
        attribute('email', {
          semantic: {
            type: 'EMAIL',
            confidence: 'HIGH',
            label: 'Email address',
            evidence: '600 of 601 sampled values are email addresses; 1 are not.',
            suggestedTransformation: 'Correct or exclude the values that are not addresses',
          },
        }),
      ],
    );
    const [invalid] = byRule(findings, 'INVALID_EMAIL');
    expect(invalid, 'the finding is raised at all').toBeTruthy();
    expect(invalid.affected, 'records, not distinct bad values').toBe(400);
    expect(invalid.affectedPercent).toBe(40);
    expect(invalid.summary).toContain('400 records');
    // The sampled figure is still shown, as evidence, labelled as sampling.
    expect(invalid.evidence.join(' ')).toContain('sampled');
  });

  it('offers the column that was meant to be the key as the near miss, not whatever happens to be unique', () => {
    /*
     * A finance export: customer_number is the intended key and repeats, while credit_limit and
     * opened_on happen not to repeat and are no use as identifiers. Ranked by distinctness alone
     * the evidence read "credit_limit: 60 distinct across 60 examined, 0 empty values" underneath
     * the sentence "no column is unique and filled in" -- refuted by its own evidence -- and
     * customer_number did not appear at all.
     */
    const findings = run(
      [
        field({ field: 'customer_number', examined: 60, distinctCount: 48, duplicateCount: 12 }),
        field({ field: 'customer_name', examined: 60, distinctCount: 52 }),
        field({ field: 'credit_limit', examined: 60, distinctCount: 60 }),
        field({ field: 'opened_on', examined: 60, distinctCount: 60 }),
      ],
      [],
      { examined: 60, totalRecords: 60, columns: 4 },
    );
    const [noKey] = byRule(findings, 'NO_RELIABLE_KEY');
    expect(noKey, 'still critical -- nothing identifies a record').toBeTruthy();

    const evidence = noKey.evidence.join(' | ');
    expect(evidence, 'the column a reader is looking for').toContain('customer_number');
    expect(evidence, 'not a column that is unique by accident').not.toContain('credit_limit');

    // And the sentence no longer claims something the evidence beneath it disproves.
    expect(noKey.summary).toContain('that could identify a record');
  });
});

describe('identity, which is what a migration actually depends on', () => {
  it('raises a critical finding when nothing identifies a record, and says what it looked at', () => {
    const findings = run([
      field({ field: 'name', distinctCount: 940 }),
      field({ field: 'city', distinctCount: 12 }),
    ]);
    const [found] = byRule(findings, 'NO_RELIABLE_KEY');
    expect(found?.severity).toBe('CRITICAL');
    expect(found?.title).toBe('No reliable record identifier');
    // The evidence has to name the columns that came closest, or "there is no key" is unfalsifiable.
    expect(found?.evidence.join(' ')).toContain('name');
    expect(found?.migrationImpact).toContain('duplicate the data rather than update it');
  });

  it('finds a candidate key, and does not then complain there is none', () => {
    const findings = run([
      field({ field: 'customer_number', distinctCount: 1000 }),
      field({ field: 'name', distinctCount: 940 }),
    ]);
    expect(byRule(findings, 'NO_RELIABLE_KEY')).toHaveLength(0);
    const [candidate] = byRule(findings, 'CANDIDATE_KEY');
    expect(candidate?.severity).toBe('INFO');
    expect(candidate?.title).toBe('customer_number looks like a business key');
    // It asks the one question that profiling cannot answer: whether the key is stable.
    expect(candidate?.recommendation).toContain('stable');
  });

  it('does not treat a column with one empty value as a key', () => {
    const findings = run([field({ field: 'customer_number', distinctCount: 999, nullCount: 1 })]);
    expect(byRule(findings, 'CANDIDATE_KEY')).toHaveLength(0);
    expect(byRule(findings, 'NO_RELIABLE_KEY')).toHaveLength(1);
  });

  it('raises the almost-unique case separately, because those records are fixable by hand', () => {
    const findings = run([
      field({ field: 'email', distinctCount: 994, duplicateCount: 6 }),
      field({ field: 'id', distinctCount: 1000 }),
    ]);
    const [nearly] = byRule(findings, 'NEARLY_UNIQUE_DUPLICATES');
    expect(nearly?.severity).toBe('WARNING');
    expect(nearly?.affected).toBe(6);
    expect(nearly?.title).toContain('almost unique, but not quite');
  });

  it('calls shared keys critical, and explains the silent overwrite', () => {
    const findings = run([field({ field: 'id', distinctCount: 980, duplicateCount: 20 })], [], {
      primaryKeyField: 'id',
      duplicateKeyCount: 20,
    });
    const [dup] = byRule(findings, 'DUPLICATE_KEYS');
    expect(dup?.severity).toBe('CRITICAL');
    expect(dup?.whyItMatters).toContain('silently overwrites');
  });
});

describe('completeness', () => {
  it('reports a column that is empty in every record, as a signal rather than a defect', () => {
    const findings = run([
      field({ field: 'legacy_notes', nullCount: 1000, distinctCount: 0 }),
      field({ field: 'id', distinctCount: 1000 }),
    ]);
    const [empty] = byRule(findings, 'EMPTY_COLUMN');
    expect(empty?.affectedPercent).toBe(100);
    expect(empty?.whyItMatters).toContain('lives somewhere else');
    expect(empty?.recommendation).toContain('Exclude');
  });

  /**
   * The threshold matters more than the rule. A product that reports every column that is 3% empty has
   * reported forty things and said nothing.
   */
  it('stays quiet about an ordinary number of gaps', () => {
    const findings = run([field({ field: 'middle_name', nullCount: 80, distinctCount: 920 })]);
    expect(byRule(findings, 'HIGH_NULL_RATE')).toHaveLength(0);
  });

  it('reports a sparse column once it is mostly empty', () => {
    const findings = run([field({ field: 'middle_name', nullCount: 400, distinctCount: 600 })]);
    const [sparse] = byRule(findings, 'HIGH_NULL_RATE');
    expect(sparse?.severity).toBe('WARNING');
    expect(sparse?.affectedPercent).toBe(40);
  });

  /** The same gap in a required column is a different problem: the run stops on it. */
  it('escalates to critical when the column is required', () => {
    const findings = run(
      [field({ field: 'account_number', nullCount: 400, distinctCount: 600 })],
      [attribute('account_number', { requiredLevel: 'ApplicationRequired' })],
    );
    const [required] = byRule(findings, 'HIGH_NULL_RATE');
    expect(required?.severity).toBe('CRITICAL');
    expect(required?.title).toContain('required but often empty');
    expect(required?.migrationImpact).toContain('blocked at preflight');
  });
});

describe('consistency and validity', () => {
  it('reports stray whitespace, and says why it is the usual cause of a failed match', () => {
    const findings = run([field({ field: 'company', whitespaceCount: 37, distinctCount: 900 })]);
    const [ws] = byRule(findings, 'WHITESPACE');
    expect(ws?.affected).toBe(37);
    expect(ws?.whyItMatters).toContain('"Acme Ltd" and "Acme Ltd "');
  });

  it('treats values that are not dates as critical', () => {
    const findings = run([field({ field: 'start_date', type: 'DateTime', invalidDateCount: 14 })]);
    const [bad] = byRule(findings, 'INVALID_DATES');
    expect(bad?.severity).toBe('CRITICAL');
    expect(bad?.whyItMatters).toContain('placeholder');
  });

  it('notices when one column holds things of wildly different lengths', () => {
    const findings = run([field({ field: 'notes', minLength: 2, maxLength: 900, averageLength: 30 })]);
    expect(titles(byRule(findings, 'LENGTH_SPREAD'))[0]).toContain('very different lengths');
  });
});

describe('semantic readings become findings only where there is a decision', () => {
  const semantic = (type: string, evidence: string, suggestion: string | null) =>
    attribute('col', {
      semantic: {
        type: type as never,
        confidence: 'HIGH',
        label: type,
        evidence,
        suggestedTransformation: suggestion,
      },
    });

  it('turns an Excel serial date into a warning that names the real risk', () => {
    const findings = run(
      [field({ field: 'col', type: 'Integer' })],
      [
        semantic(
          'EXCEL_SERIAL_DATE',
          'read as Excel serial numbers these are 2024-01-01 to 2024-03-29',
          'Convert from Excel serial number to a date',
        ),
      ],
    );
    const [date] = byRule(findings, 'DATE_AS_NUMBER');
    expect(date?.severity).toBe('WARNING');
    expect(date?.summary).toContain('2024-01-01');
    // The dangerous case is not the failure, it is the success.
    expect(date?.migrationImpact).toContain('stores a meaningless number');
  });

  it('explains why a leading zero cannot survive a numeric column', () => {
    const findings = run(
      [field({ field: 'col' })],
      [semantic('IDENTIFIER', 'Values are digits with a leading zero', 'Keep this column as text')],
    );
    expect(byRule(findings, 'IDENTIFIER_AS_TEXT')[0]?.whyItMatters).toContain('007 becomes 7');
  });

  it('says nothing about a column of web addresses, because there is nothing to decide', () => {
    const findings = run([field({ field: 'col' })], [semantic('URL', '3 of 3 are web addresses', null)]);
    expect(
      findings.filter((f) => f.columns.includes('col') && f.category === 'TYPE_COMPATIBILITY'),
    ).toHaveLength(0);
  });

  it('does not raise an email finding when every address is valid', () => {
    const findings = run(
      [field({ field: 'col' })],
      [semantic('EMAIL', 'All 1000 sampled values are email addresses.', null)],
    );
    expect(byRule(findings, 'INVALID_EMAIL')).toHaveLength(0);
  });
});

describe('privacy is named, never scored', () => {
  it('points out columns that look personal without calling them a defect', () => {
    const findings = run([
      field({ field: 'email_address' }),
      field({ field: 'date_of_birth' }),
      field({ field: 'id', distinctCount: 1000 }),
    ]);
    const [pii] = byRule(findings, 'POSSIBLE_PII');
    expect(pii?.severity).toBe('INFO');
    expect(pii?.columns).toContain('email_address');
    expect(pii?.evidence.join(' ')).toContain('not from any classification of the data itself');
  });
});

describe('a sample is reported as a sample', () => {
  it('drops confidence and says so when the numbers come from part of the table', () => {
    const findings = run([field({ field: 'name', basis: 'SAMPLED', distinctCount: 90, examined: 100 })], [], {
      basis: 'SAMPLED',
      examined: 100,
      totalRecords: 100_000,
    });
    const found = findings[0]!;
    expect(found.confidence).toBe('MEDIUM');
    expect(found.evidence.join(' ')).toContain('sample of 100 of 100,000');
  });
});

describe('readiness, which has to be arithmetic a reader can check', () => {
  const assessed = { profiled: true, relationships: false };

  it('shows the workings for every dimension', () => {
    const findings = run([
      field({ field: 'name', distinctCount: 940 }),
      field({ field: 'notes', nullCount: 1000, distinctCount: 0 }),
    ]);
    const readiness = assessReadiness(findings, assessed);
    const identity = readiness.dimensions.find((d) => d.dimension === 'IDENTITY')!;
    expect(identity.critical).toBe(1);
    expect(identity.score).toBe(65);
    expect(identity.workings).toBe('100 − 1 critical × 35 = 65');
    // Every deduction names the findings responsible, so a dimension can be opened.
    expect(identity.findingIds).toHaveLength(1);
  });

  it('refuses to score a dimension nothing examined, rather than awarding it full marks', () => {
    const readiness = assessReadiness(run([field({ field: 'id', distinctCount: 1000 })]), assessed);
    const relationships = readiness.dimensions.find((d) => d.dimension === 'RELATIONSHIPS')!;
    expect(relationships.score).toBeNull();
    expect(relationships.assessed).toBe(false);
    expect(relationships.notAssessedReason).toContain('nothing was examined');
    // And it is excluded from the average rather than counted as 100.
    expect(readiness.dimensions.filter((d) => d.assessed).length).toBeLessThan(readiness.dimensions.length);
  });

  it('gives a clean dataset its full marks and the READY band', () => {
    const readiness = assessReadiness(run([field({ field: 'id', distinctCount: 1000 })]), assessed);
    expect(readiness.score).toBe(100);
    expect(readiness.band).toBe('READY');
  });

  /**
   * The band has to be able to contradict the average. "Ready" printed beside "no record can be reliably
   * identified" is a sentence a number should not be capable of producing.
   */
  it('never says READY while a critical finding is open', () => {
    const findings = run([field({ field: 'name', distinctCount: 940 })]);
    const readiness = assessReadiness(findings, assessed);
    expect(readiness.counts.CRITICAL).toBeGreaterThan(0);
    expect(readiness.band).not.toBe('READY');
  });

  it('states its own method', () => {
    const readiness = assessReadiness([], assessed);
    expect(readiness.method).toContain('Every deduction traces to a finding you can open');
  });
});

describe('the executive summary is assembled from findings, not generated', () => {
  it('names the actual problems rather than recommending better data quality', () => {
    const findings = run([
      field({ field: 'name', distinctCount: 940 }),
      // Not unique either, or it would itself be the business key the project is missing.
      field({ field: 'start_date', type: 'DateTime', distinctCount: 300, invalidDateCount: 14 }),
    ]);
    const readiness = assessReadiness(findings, { profiled: true, relationships: false });
    const summary = executiveSummary({
      projectName: 'Customer Data Modernization',
      datasets: 4,
      tables: 12,
      records: 376_000,
      readiness,
      findings,
    });

    expect(summary).toContain('Customer Data Modernization contains 4 datasets');
    expect(summary).toContain('376,000 records');
    expect(summary).toContain('No reliable record identifier');
    // The one sentence that explains the consequence, rather than restating the score.
    expect(summary).toContain('re-running it duplicates data');
    expect(summary).not.toContain('Improve data quality');
  });

  it('says so plainly when the data is clean', () => {
    const findings = run([field({ field: 'id', distinctCount: 1000 })]);
    const readiness = assessReadiness(findings, { profiled: true, relationships: false });
    const summary = executiveSummary({
      projectName: 'Clean',
      datasets: 1,
      tables: 1,
      records: 1000,
      readiness,
      findings,
    });
    expect(summary).toContain('looks ready to migrate');
    expect(summary).toContain('no critical problems found');
  });

  it('says what it has not looked at, so the score is not read as covering everything', () => {
    const findings = run([field({ field: 'id', distinctCount: 1000 })]);
    const readiness = assessReadiness(findings, { profiled: true, relationships: false });
    const summary = executiveSummary({
      projectName: 'Finance export review',
      datasets: 3,
      tables: 3,
      records: 190,
      notAnalysed: 1,
      readiness,
      findings,
    });

    /*
     * The project has four datasets and the header says so. This paragraph used to say "contains 3
     * datasets" beside it and then quote a score, which reads as the score for the whole project.
     */
    expect(summary).toContain('contains 4 datasets');
    expect(summary).toContain('3 have been analyzed so far');
    expect(summary).toContain('not counted in anything below');
    expect(summary, 'the old sentence claimed the project was only what had been assessed').not.toContain(
      'contains 3 datasets',
    );
  });

  it('reports the whole project when nothing has been analysed at all', () => {
    const readiness = assessReadiness([], { profiled: false, relationships: false });
    const summary = executiveSummary({
      projectName: 'Fresh',
      datasets: 0,
      tables: 0,
      records: 0,
      notAnalysed: 4,
      readiness,
      findings: [],
    });
    // Not "contains 0 datasets" above a list of four.
    expect(summary).toContain('Fresh contains 4 datasets');
    expect(summary).toContain('Nothing has been analyzed yet');
  });

  it('does not pretend to assess an empty project', () => {
    const readiness = assessReadiness([], { profiled: false, relationships: false });
    const summary = executiveSummary({
      projectName: 'Empty',
      datasets: 0,
      tables: 0,
      records: 0,
      readiness,
      findings: [],
    });
    expect(summary).toContain('Nothing has been analyzed yet');
  });
});
