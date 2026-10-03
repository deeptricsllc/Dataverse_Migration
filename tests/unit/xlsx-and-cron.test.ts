import { describe, expect, it } from 'vitest';
import {
  cronError,
  describeCron,
  nextCronTime,
  parseCron,
  SCHEDULE_PRESETS,
} from '../../server/src/lib/cron';
import {
  colRef,
  columnIndex,
  readXlsx,
  rowsByHeader,
  safeSheetName,
  writeXlsx,
} from '../../server/src/lib/xlsx';
import { readZip, writeZip } from '../../server/src/lib/zip';

/**
 * The two hand-rolled formats the platform depends on: the workbook a mapping leaves and re-enters
 * the tool as, and the recurrence rule a schedule fires on. Both are places where being almost
 * right is indistinguishable from being wrong until someone's data is already in the wrong shape.
 */

describe('zip', () => {
  it('round-trips entries, compressed and stored', () => {
    const compressible = Buffer.from('a'.repeat(5000));
    const tiny = Buffer.from('no');
    const zip = writeZip([
      { path: 'a/big.txt', data: compressible },
      { path: 'b/tiny.txt', data: tiny },
    ]);
    const back = readZip(zip);
    expect(back.get('a/big.txt')!.equals(compressible)).toBe(true);
    expect(back.get('b/tiny.txt')!.equals(tiny)).toBe(true);
    // The compressible entry really was deflated rather than stored.
    expect(zip.length).toBeLessThan(compressible.length);
  });

  it('refuses something that is not a zip', () => {
    expect(() => readZip(Buffer.from('this is not a zip file'))).toThrow(/not a zip/i);
  });

  it('keeps unicode paths and content intact', () => {
    const zip = writeZip([{ path: 'données/café.txt', data: Buffer.from('naïve — ✓', 'utf8') }]);
    expect(readZip(zip).get('données/café.txt')!.toString('utf8')).toBe('naïve — ✓');
  });
});

describe('xlsx writing and reading', () => {
  it('round-trips values, types and blanks', () => {
    const book = writeXlsx([
      {
        name: 'Fields',
        columns: [{ header: 'Source' }, { header: 'Count' }, { header: 'Notes' }],
        rows: [
          ['CustomerName', 145283, 'padded'],
          ['Email', 0, null],
          ['Region', 12, ''],
        ],
      },
    ]);
    const [sheet] = readXlsx(book);
    expect(sheet.name).toBe('Fields');
    // Row 1 is the header we wrote.
    expect(sheet.rows[0]).toEqual(['Source', 'Count', 'Notes']);
    expect(sheet.rows[1]).toEqual(['CustomerName', 145283, 'padded']);
    // A zero is a number, not a blank: the difference matters in a record count.
    expect(sheet.rows[2][1]).toBe(0);
    expect(sheet.rows[2][2] ?? null).toBeNull();
  });

  it('keeps a value that looks like a formula as data', () => {
    const book = writeXlsx([
      { name: 'S', columns: [{ header: 'Value' }], rows: [['=cmd|calc'], ['+1234'], ['@SUM(A1)']] },
    ]);
    const xml = readZip(book).get('xl/worksheets/sheet1.xml')!.toString('utf8');
    // An inline string is never a formula; there is no <f> element anywhere.
    expect(xml).not.toContain('<f>');
    expect(xml).toContain('t="inlineStr"');
    const [sheet] = readXlsx(book);
    expect(sheet.rows[1][0]).toBe('=cmd|calc');
  });

  it('escapes XML and drops control characters Excel rejects', () => {
    const book = writeXlsx([
      {
        name: 'S',
        columns: [{ header: 'V' }],
        rows: [['a & b < c > d "quoted"'], [`bell\u0007here`]],
      },
    ]);
    const [sheet] = readXlsx(book);
    expect(sheet.rows[1][0]).toBe('a & b < c > d "quoted"');
    expect(sheet.rows[2][0]).toBe('bellhere');
  });

  it('writes several sheets, notes above the header, and de-duplicates sheet names', () => {
    const book = writeXlsx([
      { name: 'Tables', columns: [{ header: 'A' }], rows: [['x']], notes: ['Fill in column A only.'] },
      { name: 'Tables', columns: [{ header: 'B' }], rows: [['y']] },
      { name: 'Bad:Name*Here', columns: [{ header: 'C' }], rows: [] },
    ]);
    const sheets = readXlsx(book);
    expect(sheets.map((s) => s.name)).toEqual(['Tables', 'Tables (2)', 'Bad Name Here']);
    // The note occupies row 1, so the header moved down to row 2.
    expect(sheets[0].rows[0][0]).toBe('Fill in column A only.');
    expect(sheets[0].rows[1]).toEqual(['A']);
    expect(sheets[0].rows[2]).toEqual(['x']);
  });

  it('reads a workbook written the way Excel writes one', () => {
    // Shared strings, cells out of order, an omitted empty cell, and styles we never emit. A
    // reader that trusts arrival order instead of the r="" reference shifts every later column.
    const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="C2" t="s"><v>4</v></c><c r="A2" t="s"><v>3</v></c></row><row r="3"><c r="A3" s="4" t="s"><v>5</v></c><c r="C3"><v>42</v></c></row></sheetData></worksheet>`;
    const shared = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6"><si><t>Source Field</t></si><si><t>Target Field</t></si><si><t>Notes</t></si><si><t>CustomerName</t></si><si><t>keep</t></si><si><r><t>Email</t></r><r><t>Address</t></r></si></sst>`;
    const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Field mapping" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
    const file = writeZip([
      { path: 'xl/workbook.xml', data: Buffer.from(workbook) },
      { path: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels) },
      { path: 'xl/sharedStrings.xml', data: Buffer.from(shared) },
      { path: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
    ]);

    const [read] = readXlsx(file);
    expect(read.name).toBe('Field mapping');
    expect(read.rows[0]).toEqual(['Source Field', 'Target Field', 'Notes']);
    // Cell B2 was omitted entirely; C2 must still land in column 2.
    expect(read.rows[1]).toEqual(['CustomerName', null, 'keep']);
    // A shared string split across formatting runs is one value.
    expect(read.rows[2][0]).toBe('EmailAddress');
    expect(read.rows[2][2]).toBe(42);
  });

  it('finds the header row by its labels, however the sheet was rearranged', () => {
    const book = writeXlsx([
      {
        name: 'Field mapping',
        columns: [{ header: 'Source Field' }, { header: 'Target Field' }, { header: 'Transformation' }],
        rows: [
          ['CustomerName', 'name', 'TRIM'],
          ['Email', 'emailaddress1', ''],
        ],
        notes: ['Edit the Target Field column and send this back.', 'Leave Source Field alone.'],
      },
    ]);
    const [sheet] = readXlsx(book);
    const found = rowsByHeader(sheet, ['Source Field', 'Target Field']);
    expect(found).not.toBeNull();
    expect(found!.rows).toHaveLength(2);
    // Header lookup is insensitive to case, spaces and punctuation.
    expect(found!.rows[0]).toMatchObject({ sourcefield: 'CustomerName', targetfield: 'name' });
    expect(found!.rows[1].transformation).toBe('');
    // A sheet without the required headers is reported as such rather than guessed at.
    expect(rowsByHeader(sheet, ['Source Field', 'Destination Column'])).toBeNull();
  });

  it('converts column references both ways', () => {
    expect([0, 25, 26, 27, 51, 52].map(colRef)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA']);
    expect(['A1', 'Z9', 'AA12', '$AB$3'].map(columnIndex)).toEqual([0, 25, 26, 27]);
    expect(safeSheetName('a/very*long:name?that[is]too long to fit in a tab')).toHaveLength(31);
    expect(safeSheetName('')).toBe('Sheet');
  });
});

describe('cron', () => {
  const utc = (iso: string) => new Date(`${iso}Z`);

  it('parses fields, lists, ranges, steps and names', () => {
    expect([...parseCron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 9-17 * * *').hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parseCron('0 0 * * mon-fri').daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 1 jan,jul *').months]).toEqual([1, 7]);
    expect([...parseCron('0,30 * * * *').minutes]).toEqual([0, 30]);
    // Sunday is both 0 and 7.
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
    expect([...parseCron('0 0 * * 0').daysOfWeek]).toEqual([0]);
  });

  it('rejects what it cannot honour', () => {
    expect(() => parseCron('* * * *')).toThrow(/five fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('0 25 * * *')).toThrow(/out of range/);
    expect(() => parseCron('0 0 * * 9')).toThrow(/out of range/);
    expect(() => parseCron('0 17-9 * * *')).toThrow(/backwards/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
    expect(cronError('nonsense')).toMatch(/five fields/);
    expect(cronError('*/15 * * * *')).toBeNull();
    expect(cronError('0 0 * * *', 'Not/AZone')).toMatch(/time zone/i);
  });

  it('finds the next firing time, strictly after the given instant', () => {
    // Already exactly on a firing minute: the next one is the following interval, not this one.
    expect(nextCronTime('*/15 * * * *', utc('2026-03-10T10:15:00'))!.toISOString()).toBe(
      '2026-03-10T10:30:00.000Z',
    );
    expect(nextCronTime('*/15 * * * *', utc('2026-03-10T10:16:30'))!.toISOString()).toBe(
      '2026-03-10T10:30:00.000Z',
    );
    expect(nextCronTime('0 2 * * *', utc('2026-03-10T10:00:00'))!.toISOString()).toBe(
      '2026-03-11T02:00:00.000Z',
    );
    // 2026-03-10 is a Tuesday, so the next Sunday 01:00 is the 15th.
    expect(nextCronTime('0 1 * * 0', utc('2026-03-10T10:00:00'))!.toISOString()).toBe(
      '2026-03-15T01:00:00.000Z',
    );
    expect(nextCronTime('0 0 1 * *', utc('2026-03-10T10:00:00'))!.toISOString()).toBe(
      '2026-04-01T00:00:00.000Z',
    );
  });

  it('treats a restricted day-of-month and day-of-week as either, the way cron does', () => {
    // The 13th or any Friday — so Wednesday the 13th of May 2026 counts, and so does every Friday.
    // 2026-05-01 is itself a Friday, but "strictly after" rules out its own midnight.
    const next = nextCronTime('0 0 13 * fri', utc('2026-05-01T00:00:00'))!;
    expect(next.toISOString()).toBe('2026-05-08T00:00:00.000Z');
    const after = nextCronTime('0 0 13 * fri', utc('2026-05-02T00:00:00'))!;
    expect(after.toISOString()).toBe('2026-05-08T00:00:00.000Z');
    const thirteenth = nextCronTime('0 0 13 * fri', utc('2026-05-09T00:00:00'))!;
    expect(thirteenth.toISOString()).toBe('2026-05-13T00:00:00.000Z');
  });

  it('honours the wall clock in a time zone across a daylight-saving change', () => {
    // 02:30 every night, London. The clocks go back at 02:00 BST on Sunday 2026-10-25, so by the
    // time 02:30 local comes round that morning it is already GMT — the same wall clock, a
    // different offset. This is the assertion that fails for any implementation doing offset maths.
    const beforeChange = nextCronTime('30 2 * * *', utc('2026-10-24T12:00:00'), 'Europe/London')!;
    expect(beforeChange.toISOString()).toBe('2026-10-25T02:30:00.000Z');
    const winter = nextCronTime('30 2 * * *', utc('2026-11-15T12:00:00'), 'Europe/London')!;
    expect(winter.toISOString()).toBe('2026-11-16T02:30:00.000Z');
    const summer = nextCronTime('30 2 * * *', utc('2026-07-15T12:00:00'), 'Europe/London')!;
    expect(summer.toISOString()).toBe('2026-07-16T01:30:00.000Z'); // 02:30 BST
    // A daily 02:30 in New York keeps firing across the spring-forward, not skipping the day.
    const spring = nextCronTime('30 2 * * *', utc('2026-03-08T00:00:00'), 'America/New_York')!;
    expect(spring.getTime()).toBeGreaterThan(utc('2026-03-08T00:00:00').getTime());
  });

  it('describes a schedule in words, and every preset parses', () => {
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeCron('0 2 * * *')).toBe('Every day at 02:00');
    expect(describeCron('0 6 * * 1-5')).toBe('Every weekday at 06:00');
    expect(describeCron('0 1 * * 0')).toBe('Every Sunday at 01:00');
    expect(describeCron('0 */4 * * *')).toBe('Every 4 hours');
    expect(describeCron('30 */4 * * *')).toBe('Every 4 hours at 30 past');
    expect(describeCron('@daily')).toBe('Every day at 00:00');
    for (const preset of SCHEDULE_PRESETS) {
      expect(cronError(preset.cron), preset.cron).toBeNull();
      expect(describeCron(preset.cron)).toBe(preset.label);
    }
  });
});
