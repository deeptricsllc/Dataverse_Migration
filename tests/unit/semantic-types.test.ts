import { describe, expect, it } from 'vitest';
import { detectSemanticType, excelSerialToIsoDate } from '../../shared/semantic-types';

/**
 * What a column means, as opposed to how it is stored.
 *
 * The case that prompted this: a project spreadsheet whose `Start Date` and `End Date` columns profiled as
 * `Integer`, with values like 45292 and 45380. That was a true statement about the storage and a useless
 * one about the data — those are 2024-01-01 and 2024-03-29, and a user who migrated that column into a date
 * field would have found out afterwards.
 *
 * The thing these cases guard is restraint. A detector that fires often is worse than one that fires
 * rarely, because every false reading next to a true fact teaches the user to discount both. So most of
 * what follows asserts that something is **not** detected.
 */

const sample = (
  name: string,
  values: string[],
  extra: Partial<Parameters<typeof detectSemanticType>[0]> = {},
) =>
  detectSemanticType({
    name,
    storageType: 'String',
    values,
    distinct: new Set(values).size,
    populated: values.length,
    ...extra,
  });

describe('Excel serial dates', () => {
  it('converts a serial to the date Excel shows for it', () => {
    // The three a reader can check against a spreadsheet without trusting the epoch arithmetic.
    expect(excelSerialToIsoDate(45292)).toBe('2024-01-01');
    expect(excelSerialToIsoDate(45380)).toBe('2024-03-29');
    expect(excelSerialToIsoDate(25569)).toBe('1970-01-01');
  });

  /**
   * Below 61 the 1900-leap-year bug makes the answer ambiguous, so nothing is offered rather than
   * something that is wrong by a day for two months of 1900.
   */
  it('refuses the range where Excel’s own leap-year bug makes it ambiguous', () => {
    expect(excelSerialToIsoDate(1)).toBeNull();
    expect(excelSerialToIsoDate(60)).toBeNull();
    expect(excelSerialToIsoDate(61)).not.toBeNull();
  });

  it('reads a date-named column of serials as dates, with high confidence', () => {
    const reading = sample('Start Date', ['45292', '45380', '45291', '45310']);
    expect(reading?.type).toBe('EXCEL_SERIAL_DATE');
    expect(reading?.confidence).toBe('HIGH');
    expect(reading?.evidence).toContain('2024-03-29');
    expect(reading?.suggestedTransformation).toContain('Convert');
  });

  /**
   * The heading carries the confidence. Numbers in the plausible window are weak evidence on their own —
   * quantities and reference numbers live there too — so without a date-like name the reading survives but
   * is marked for a human to look at.
   */
  it('drops to medium confidence when the column name does not agree', () => {
    const reading = sample('Reference', ['45292', '45380', '45291']);
    expect(reading?.type).toBe('EXCEL_SERIAL_DATE');
    expect(reading?.confidence).toBe('MEDIUM');
    expect(reading?.evidence).toContain('does not confirm');
  });

  it('never claims a serial date for values outside the plausible window', () => {
    // Quantities, prices in pence, row counts, small references.
    expect(sample('Quantity', ['1', '2', '3', '12'])?.type).not.toBe('EXCEL_SERIAL_DATE');
    expect(sample('Units Sold', ['120', '450', '8800'])?.type).not.toBe('EXCEL_SERIAL_DATE');
    expect(sample('Population', ['950000', '1200000'])?.type).not.toBe('EXCEL_SERIAL_DATE');
  });

  it('refuses the reading when even one value is not a number', () => {
    // A single "N/A" means this is a text column containing numbers, which is a different problem.
    const reading = sample('Start Date', ['45292', 'N/A', '45380']);
    expect(reading?.type).not.toBe('EXCEL_SERIAL_DATE');
  });

  it('does not read a year column as a serial date', () => {
    expect(sample('Year', ['2019', '2020', '2021', '2024'])?.type).not.toBe('EXCEL_SERIAL_DATE');
  });
});

describe('readings that are worth making', () => {
  /**
   * The column a user most needs told about: an email column with real problems in it.
   *
   * A threshold strict enough to call this ordinary text would hide the finding behind the strictness
   * meant to prevent false ones. So the reading is still made, the bad count is named, and the confidence
   * carries the doubt.
   */
  it('recognises an email column that has malformed values, and counts them', () => {
    const values = [
      ...Array.from({ length: 18 }, (_, i) => `person${i}@example.com`),
      'not-an-email',
      'also bad',
    ];
    const reading = sample('Contact', values);
    expect(reading?.type).toBe('EMAIL');
    expect(reading?.confidence, '10% malformed is worth a second look').toBe('MEDIUM');
    expect(reading?.evidence).toContain('18 of 20');
    expect(reading?.evidence).toContain('2 are not');
    expect(reading?.suggestedTransformation).toContain('Correct or exclude');
  });

  /** And a quarter of the column being wrong is genuinely ambiguous, so nothing is claimed. */
  it('claims nothing when a quarter of the values do not fit', () => {
    expect(sample('Contact', ['a@b.com', 'c@d.co.uk', 'e@f.org', 'not-an-email'])).toBeNull();
  });

  it('suggests nothing for a clean email column', () => {
    expect(sample('Email', ['a@b.com', 'c@d.com'])?.suggestedTransformation).toBeNull();
  });

  it('recognises identifiers written with a leading zero, and says why it matters', () => {
    const reading = sample('Part No', ['007', '012', '0456']);
    expect(reading?.type).toBe('IDENTIFIER');
    expect(reading?.evidence).toContain('007');
    expect(reading?.suggestedTransformation).toBe('Keep this column as text');
  });

  it('recognises money and percentages, and names the decision each needs', () => {
    expect(sample('Amount', ['$1,200.00', '$45.50'])?.type).toBe('CURRENCY');
    const pct = sample('Margin', ['15%', '7.5%', '92%']);
    expect(pct?.type).toBe('PERCENTAGE');
    expect(pct?.suggestedTransformation).toContain('15% as 15 or as 0.15');
  });

  it('reads a punctuated phone column as a phone number, and only at medium confidence', () => {
    const reading = sample('Phone', ['+44 20 7946 0958', '(555) 123-4567', '020 7946 0321']);
    expect(reading?.type).toBe('PHONE');
    expect(reading?.confidence, 'a phone number has no universal format').toBe('MEDIUM');
  });

  /** The restraint that keeps PHONE from swallowing every reference column in the file. */
  it('does not call an unpunctuated run of digits a phone number', () => {
    expect(sample('Account Ref', ['12345678', '23456789', '34567890'])?.type).not.toBe('PHONE');
  });

  it('reports a column with no values at all, because that is a finding on its own', () => {
    const reading = detectSemanticType({
      name: 'Legacy Notes',
      storageType: 'String',
      values: [],
      distinct: 0,
      populated: 0,
    });
    expect(reading?.type).toBe('EMPTY');
    expect(reading?.evidence).toContain('No row');
  });
});

describe('categorical, which is only interesting when the ratio is extreme', () => {
  it('recognises a small fixed set across many rows', () => {
    const values = Array.from({ length: 400 }, (_, i) => ['Open', 'Closed', 'Pending'][i % 3]!);
    const reading = sample('Status', values, { distinct: 3, populated: 400 });
    expect(reading?.type).toBe('CATEGORICAL');
    expect(reading?.evidence).toContain('3 distinct values across 400 rows');
  });

  /** Three distinct values across nine rows is a short file, not a choice column. */
  it('says nothing about a short file with few values', () => {
    const reading = sample('Status', ['Open', 'Closed', 'Open'], { distinct: 2, populated: 3 });
    expect(reading).toBeNull();
  });

  it('says nothing when almost every value is distinct', () => {
    const values = Array.from({ length: 200 }, (_, i) => `Customer ${i}`);
    expect(sample('Customer Name', values, { distinct: 200, populated: 200 })).toBeNull();
  });
});

describe('the restraint that makes the rest believable', () => {
  it('returns nothing for an ordinary text column', () => {
    expect(sample('Description', ['Widget assembly', 'Annual service', 'Replacement part'])).toBeNull();
  });

  it('returns nothing for free-form notes that merely contain an address-like word', () => {
    expect(sample('Notes', ['see a@b.com for detail', 'call them', 'no further action'])).toBeNull();
  });

  it('never returns a reading it would describe as a guess', () => {
    // There is deliberately no LOW confidence: anything that weak is not reported at all.
    const readings = [
      sample('Mixed', ['1', 'two', '3.0', 'four']),
      sample('Codes', ['AB', 'CD-12', 'xyz', '77']),
    ];
    for (const reading of readings) {
      if (reading) expect(['HIGH', 'MEDIUM']).toContain(reading.confidence);
    }
  });
});
