import { describe, expect, it } from 'vitest';
import { inferTable, ROW_KEY, toTableMetadata } from '../../server/src/connectors/staged/infer-schema';
import { parseDelimited, prepareSheet, tableNameFor } from '../../server/src/services/staged-source-service';
import { familyOf } from '../../shared/metadata';

/**
 * Working out what a spreadsheet's columns are.
 *
 * The inference is deliberately asymmetric: calling a text column a number makes every non-numeric
 * row fail at migration time, while calling a number column text costs one conversion the engine
 * already does. So a narrower type is only chosen when every non-empty value fits it — one "N/A" in a
 * thousand rows keeps the column as text, which is the correct answer about that column.
 */

const infer = (headers: string[], rows: (string | number | boolean | null)[][]) =>
  inferTable('t', 'T', headers, rows);

const columnNamed = (headers: string[], rows: (string | number | boolean | null)[][], name: string) =>
  infer(headers, rows).columns.find((c) => c.name === name)!;

describe('reading a delimited file without editing it', () => {
  /**
   * The rule for this whole subsystem: a value arrives in the target as it was in the file, unless a
   * mapping or a transformation says otherwise. Reading is not a transformation.
   */
  it('keeps commas inside the values of a semicolon-separated file', () => {
    // A European export, and the shape that was being quietly damaged: a comma in an unquoted field.
    const rows = parseDelimited('name;note' + '\r\n' + 'Smith, John;ok' + '\r\n' + 'Doe, Jane;fine');
    expect(rows[0]).toEqual(['name', 'note']);
    expect(rows[1], 'the comma in the name survives').toEqual(['Smith, John', 'ok']);
    expect(rows[2]).toEqual(['Doe, Jane', 'fine']);
  });

  it('does the same for tab-separated files', () => {
    const rows = parseDelimited('a' + '\t' + 'b' + '\r\n' + '1,5' + '\t' + 'two, three');
    expect(rows[1]).toEqual(['1,5', 'two, three']);
  });

  it('still reads an ordinary comma-separated file, quoting and all', () => {
    const rows = parseDelimited('a,b' + '\r\n' + '"has, comma","has ""quotes"""');
    expect(rows[1]).toEqual(['has, comma', 'has "quotes"']);
  });

  it('reads a value containing a newline, which only quoting can express', () => {
    const rows = parseDelimited('a,b' + '\r\n' + '"line one' + '\n' + 'line two",second');
    expect(rows[1]![0]).toBe('line one' + '\n' + 'line two');
    expect(rows[1]![1]).toBe('second');
    expect(rows.length, 'one row, not two').toBe(2);
  });

  it('strips a byte-order mark without eating the first column name', () => {
    const rows = parseDelimited('\uFEFF' + 'code,name' + '\r\n' + '1,one');
    expect(rows[0]).toEqual(['code', 'name']);
  });

  it('leaves a formula-looking value exactly as written', () => {
    // Neutralising it belongs to the export, where a spreadsheet would evaluate it. On the way in it is
    // a value, and changing it here would be an edit nobody asked for.
    const rows = parseDelimited('a,b' + '\r\n' + '=1+1,@SUM(A1)');
    expect(rows[1]).toEqual(['=1+1', '@SUM(A1)']);
  });
});

describe('identifiers that happen to be digits', () => {
  /**
   * The one inference that cannot be undone. A part number of `007` read as a number is the number
   * seven, and nothing downstream reports a difference, because by then the value *is* seven. The source
   * said 007; the target says 7; every count agrees. This is the shape of silent data loss.
   */
  it('keeps a leading zero as text rather than making it a number', () => {
    const column = columnNamed(['part'], [['007'], ['0012'], ['0999']], 'part');
    expect(column.type, 'a part number is not a number').toBe('String');
    expect(column.reason).toMatch(/leading zero/i);
    expect(column.reason).toMatch(/identifier/i);
  });

  it('applies to postcodes, account references and anything else written with zeros', () => {
    for (const values of [
      ['01234', '02345', '03456'], // postcodes
      ['000123', '000124'], // account references
      ['0', '00', '000'], // a column of nothing but zeros
      ['1', '2', '0012'], // one value is enough: the column holds an identifier
    ]) {
      const column = columnNamed(
        ['code'],
        values.map((v) => [v]),
        'code',
      );
      expect(column.type, values.join(',')).toBe('String');
    }
  });

  it('still calls a real number a number', () => {
    // A single zero is a number, and so is anything with a decimal point after the zero.
    expect(columnNamed(['n'], [['0'], ['1'], ['2']], 'n').type).toBe('Integer');
    expect(columnNamed(['n'], [['0.5'], ['1.5']], 'n').type).toBe('Decimal');
    expect(columnNamed(['n'], [['10'], ['200'], ['-3']], 'n').type).toBe('Integer');
    expect(columnNamed(['n'], [['-0.25'], ['1']], 'n').type).toBe('Decimal');
  });

  it('covers decimals with leading zeros too, which a Decimal type would also lose', () => {
    // `0012.50` is a reference with a decimal point in it, not a price.
    const column = columnNamed(['ref'], [['0012.50'], ['0013.75']], 'ref');
    expect(column.type).toBe('String');
    expect(column.reason).toMatch(/leading zero/i);
  });
});

describe('column types', () => {
  it('narrows only when every value fits', () => {
    const headers = ['clean', 'dirty'];
    const rows = [
      ['1', '1'],
      ['2', '2'],
      // Not a blank — a real value that is not a number. "N/A" would count as empty, which is
      // covered separately.
      ['3', 'pending'],
    ];
    expect(columnNamed(headers, rows, 'clean').type).toBe('Integer');
    // One unparseable value is the whole point: this column really does contain something else.
    expect(columnNamed(headers, rows, 'dirty').type).toBe('String');
    expect(columnNamed(headers, rows, 'dirty').reason).toMatch(/mixed values/);
  });

  it('treats the usual ways of writing nothing as nothing', () => {
    const col = columnNamed(['amount'], [['10'], [''], ['-'], ['N/A'], ['NULL'], ['20']], 'amount');
    // Those are blanks, not values, so the column is still numeric.
    expect(col.type).toBe('Integer');
    expect(col.blanks).toBe(4);
  });

  it('recognises numbers, dates, GUIDs and booleans', () => {
    expect(columnNamed(['n'], [['1.5'], ['2.25']], 'n').type).toBe('Decimal');
    expect(columnNamed(['d'], [['2026-01-31'], ['2026-02-01']], 'd').type).toBe('DateTime');
    expect(columnNamed(['d'], [['2026-01-31T09:00:00Z']], 'd').type).toBe('DateTime');
    expect(columnNamed(['g'], [['9f1c2b3a-0000-0000-0000-000000000001']], 'g').type).toBe('Uniqueidentifier');
    expect(columnNamed(['b'], [['yes'], ['no'], ['YES']], 'b').type).toBe('Boolean');
    expect(columnNamed(['b'], [['true'], ['false']], 'b').type).toBe('Boolean');
  });

  it('does not call a column of ones and zeroes a boolean', () => {
    // A column of 0 and 1 is as often a count or a flag stored as a number. Reading it as a boolean
    // would turn 1 into true and lose the ability to sum it.
    const col = columnNamed(['qty'], [['0'], ['1'], ['1'], ['0']], 'qty');
    expect(col.type).toBe('Integer');
  });

  it('refuses to guess which number is the day', () => {
    // 03/04/2026 is two different dates depending on where the file came from, and there is nothing
    // in the file that says which. Text is the honest answer.
    const col = columnNamed(['when'], [['03/04/2026'], ['11/12/2026']], 'when');
    expect(col.type).toBe('String');
    expect(col.reason).toMatch(/ambiguous/);
  });

  it('keeps whole numbers it cannot hold exactly as text', () => {
    // A 19-digit account number is not a quantity, and rounding it silently changes an identity.
    const col = columnNamed(['account'], [['12345678901234567890'], ['12345678901234567891']], 'account');
    expect(col.type).toBe('String');
    expect(col.reason).toMatch(/too large/);
  });

  it('measures length and uniqueness, and says a column was empty', () => {
    const col = columnNamed(['name'], [['abc'], ['abcdef'], ['']], 'name');
    expect(col.maxLength).toBe(6);
    expect(col.unique).toBe(true);
    const empty = columnNamed(['unused'], [[''], [''], ['']], 'unused');
    expect(empty.type).toBe('String');
    expect(empty.reason).toMatch(/no values/);
  });

  it('gives a blank or duplicated heading a usable name instead of dropping its data', () => {
    const table = infer(['id', '', 'Name', 'Name'], [['1', 'x', 'a', 'b']]);
    expect(table.columns.map((c) => c.name)).toEqual(['id', 'column_2', 'Name', 'Name 2']);
  });
});

describe('what identifies a row', () => {
  it('uses a unique, always-present, key-shaped column', () => {
    const table = infer(
      ['customer_id', 'name'],
      [
        ['C1', 'Ann'],
        ['C2', 'Bo'],
      ],
    );
    expect(table.keyColumn).toBe('customer_id');
    expect(table.keyIsSynthetic).toBe(false);
  });

  it('invents one rather than picking a column by accident', () => {
    // `name` here is unique and never empty, but it is not a key: it stops being unique the moment
    // a second Ann arrives — after the mapping was built on it.
    const table = infer(
      ['name', 'city'],
      [
        ['Ann', 'Leeds'],
        ['Bo', 'York'],
      ],
    );
    expect(table.keyIsSynthetic).toBe(true);
    expect(table.keyColumn).toBe(ROW_KEY);
  });

  it('will not use a key column that has gaps or repeats', () => {
    expect(
      infer(
        ['id', 'x'],
        [
          ['1', 'a'],
          ['', 'b'],
        ],
      ).keyIsSynthetic,
    ).toBe(true);
    expect(
      infer(
        ['id', 'x'],
        [
          ['1', 'a'],
          ['1', 'b'],
        ],
      ).keyIsSynthetic,
    ).toBe(true);
  });

  it('picks a display column that reads like a label', () => {
    expect(infer(['id', 'city', 'company_name'], [['1', 'Leeds', 'Acme']]).nameColumn).toBe('company_name');
  });
});

describe('the metadata a file produces', () => {
  it('is tabular, read-only and never a target', () => {
    const meta = toTableMetadata(
      infer(
        ['customer_id', 'name', 'employees'],
        [
          ['C1', 'Acme', '10'],
          ['C2', 'Globex', '20'],
        ],
      ),
    );
    // TABULAR is what makes the rest of the platform convert values out of it rather than copy them.
    expect(meta.attributes.every((a) => familyOf(a) === 'TABULAR')).toBe(true);
    // A file is never written to, and `isView` is how the planner already refuses a target.
    expect(meta.isView).toBe(true);
    expect(meta.attributes.every((a) => !a.isValidForCreate && !a.isValidForUpdate)).toBe(true);
    expect(meta.attributes.every((a) => a.isValidForRead)).toBe(true);
    // Nothing in a file is required: the file is the whole truth about what it contains.
    expect(meta.attributes.every((a) => a.requiredLevel === 'None' || a.logicalName === ROW_KEY)).toBe(true);

    expect(meta.primaryIdAttribute).toBe('customer_id');
    expect(meta.primaryNameAttribute).toBe('name');
    // A detected key is published as an alternate key so a migration can match on it.
    expect(meta.keys[0].attributes).toEqual(['customer_id']);
  });

  it('adds the synthetic row key only when it had to', () => {
    const withKey = toTableMetadata(infer(['id'], [['1']]));
    expect(withKey.attributes.some((a) => a.logicalName === ROW_KEY)).toBe(false);
    const without = toTableMetadata(infer(['city'], [['Leeds'], ['York']]));
    expect(without.primaryIdAttribute).toBe(ROW_KEY);
    // A row number means nothing outside this import, so it is never mapped anywhere.
    const rowKey = without.attributes.find((a) => a.logicalName === ROW_KEY)!;
    expect(rowKey.isValidForCreate).toBe(false);
    expect(without.keys).toEqual([]);
  });
});

describe('reading the file itself', () => {
  it('detects the delimiter instead of assuming a comma', () => {
    // A CSV exported in a locale that uses the comma for decimals is semicolon-delimited. Reading it
    // as commas produces one column of nonsense rather than an error.
    const semi = parseDelimited('name;amount\r\nAcme;1,50\r\nGlobex;2,75');
    expect(semi[0]).toEqual(['name', 'amount']);
    expect(semi[1][0]).toBe('Acme');
    const tabbed = parseDelimited('name\tamount\nAcme\t10');
    expect(tabbed[0]).toEqual(['name', 'amount']);
    const comma = parseDelimited('name,amount\nAcme,10');
    expect(comma[1]).toEqual(['Acme', '10']);
  });

  it('respects quoting when detecting and when splitting', () => {
    const rows = parseDelimited('name,note\n"Acme, Inc.","said ""hello"""');
    expect(rows[1]).toEqual(['Acme, Inc.', 'said "hello"']);
  });

  it('finds the header row under a title and a blank line', () => {
    // Real exports put a title and a date above the header.
    const found = prepareSheet({
      name: 'Sheet1',
      rows: [['Customer export'], [], ['id', 'name'], ['1', 'Acme']],
    })!;
    expect(found.headers).toEqual(['id', 'name']);
    expect(found.rows).toEqual([['1', 'Acme']]);
  });

  it('drops trailing empty columns and fully empty rows', () => {
    const found = prepareSheet({
      name: 'S',
      rows: [['id', 'name', '', ''], ['1', 'Acme', '', ''], [], ['2', 'Globex', '', '']],
    })!;
    expect(found.headers).toEqual(['id', 'name']);
    expect(found.rows).toHaveLength(2);
  });

  it('reports a sheet with nothing in it rather than failing', () => {
    expect(prepareSheet({ name: 'Empty', rows: [] })).toBeNull();
    expect(prepareSheet({ name: 'HeaderOnly', rows: [['id', 'name']] })).toBeNull();
  });

  it('makes a stable table name from a file name', () => {
    expect(tableNameFor('Customer Export (2026).csv', 'x')).toBe('customer_export_2026');
    expect(tableNameFor('', 'Sheet1')).toBe('sheet1');
  });
});

/**
 * An uploaded file as a migration *source*, which is a different question from reading it.
 *
 * The inference above decides what the columns are. These check the three places that decided an
 * uploaded file could not be migrated from at all — found by uploading a 1,200-row CSV to deployed QA
 * and trying to pair it with a Dataverse table.
 */
describe('an upload as a migration source', () => {
  const inferred = infer(
    ['code', 'full_name', 'amount'],
    [
      ['C-001', 'First', '10.50'],
      ['C-002', 'Second', '20.25'],
    ],
  );
  const meta = toTableMetadata(inferred);

  it('marks the key column as the primary identifier, which is what started the trouble', () => {
    expect(inferred.keyColumn).toBe('code');
    expect(inferred.keyIsSynthetic).toBe(false);
    expect(meta.primaryIdAttribute).toBe('code');
  });

  it('marks every column unwritable, truthfully, about the file rather than the data', () => {
    for (const attr of meta.attributes) {
      expect(attr.isValidForCreate, `${attr.logicalName} is not writable`).toBe(false);
      expect(attr.isValidForUpdate, `${attr.logicalName} is not writable`).toBe(false);
      expect(attr.isValidForRead, `${attr.logicalName} is readable`).toBe(true);
    }
  });

  it('keeps the family that tells the rest of the platform this is a file', () => {
    // The signal the mapping rules use to tell "the key is a business value" from "the key is a GUID".
    for (const attr of meta.attributes) expect(familyOf(attr)).toBe('TABULAR');
  });
});

/**
 * The reading that sits alongside the storage type.
 *
 * `inferTable` answers "what will the engine read". These cases cover the second question a user actually
 * has, which is "what is this column *for*" — and the specific failure that prompted it: a spreadsheet
 * whose `Start Date` column profiled as `Integer` with values like 45292, which is a true statement about
 * the storage and a useless one about the data.
 *
 * `shared/semantic-types.ts` has the detector's own cases. These prove it is reached through the real
 * inference path and survives into the metadata a screen reads, which is the half a unit test of the
 * detector cannot see.
 */
describe('semantic readings reach the inferred table', () => {
  const rows = [
    ['Rollout', '45292', '45380', 'a@b.com', '007'],
    ['Audit', '45300', '45400', 'c@d.com', '012'],
    ['Upgrade', '45310', '45420', 'e@f.com', '0456'],
  ];
  const headers = ['Task', 'Start Date', 'End Date', 'Owner Email', 'Ref'];

  it('keeps the storage type and adds what the values mean', () => {
    const inferred = inferTable('tasks', 'Tasks', headers, rows);
    const byName = new Map(inferred.columns.map((c) => [c.name, c]));

    const start = byName.get('Start Date')!;
    // The storage type is still the observed truth. The engine reads integers here.
    expect(start.type).toBe('Integer');
    // And the reading says what they are, with the date a person can check.
    expect(start.semantic?.type).toBe('EXCEL_SERIAL_DATE');
    expect(start.semantic?.confidence).toBe('HIGH');
    expect(start.semantic?.evidence).toContain('2024-01-01');
    expect(start.semantic?.suggestedTransformation).toContain('Convert');

    expect(byName.get('End Date')!.semantic?.type).toBe('EXCEL_SERIAL_DATE');
    expect(byName.get('Owner Email')!.semantic?.type).toBe('EMAIL');
    // Leading-zero digits are already kept as text by the storage inference; the reading says why.
    expect(byName.get('Ref')!.type).toBe('String');
    expect(byName.get('Ref')!.semantic?.type).toBe('IDENTIFIER');
    // An ordinary text column gets no reading at all, which is most of them.
    expect(byName.get('Task')!.semantic).toBeNull();
  });

  it('survives into the attribute metadata a screen reads', () => {
    const meta = toTableMetadata(inferTable('tasks', 'Tasks', headers, rows));
    const start = meta.attributes.find((a) => a.logicalName === 'Start Date');
    expect(start?.type, 'the storage type a target column must accept').toBe('Integer');
    expect(start?.semantic?.label).toBe('Date, stored as an Excel serial number');
    expect(meta.attributes.find((a) => a.logicalName === 'Task')?.semantic).toBeNull();
  });

  it('reports a column that is empty in every row', () => {
    const withEmpty = rows.map((r) => [...r, '']);
    const inferred = inferTable('tasks', 'Tasks', [...headers, 'Legacy Notes'], withEmpty);
    const notes = inferred.columns.find((c) => c.name === 'Legacy Notes')!;
    expect(notes.semantic?.type).toBe('EMPTY');
    expect(notes.semantic?.evidence).toContain('No row');
  });

  it('does not transform anything by detecting it', () => {
    // The suggestion is a suggestion. The inferred type is untouched by the reading, which is what keeps
    // "observed" and "inferred" separable all the way to the screen.
    const inferred = inferTable('tasks', 'Tasks', headers, rows);
    const start = inferred.columns.find((c) => c.name === 'Start Date')!;
    expect(start.type).toBe('Integer');
    expect(start.semantic?.suggestedTransformation).toBeTruthy();
  });
});
