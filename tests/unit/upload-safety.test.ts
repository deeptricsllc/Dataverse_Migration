import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { columnIndex, readXlsx, writeXlsx } from '../../server/src/lib/xlsx';
import { readZip, writeZip } from '../../server/src/lib/zip';

/**
 * Two ways a small upload could take the process down.
 *
 * Both matter because the file passes every size check: the expensive thing is not the bytes, it is a
 * number inside them. A declared row of two billion, or an entry that inflates a thousandfold, costs
 * nothing to send and everything to process. Neither is a parsing bug — each is a missing bound.
 */

/** A ZIP whose single entry inflates enormously from almost nothing. */
function zipBomb(uncompressedBytes: number): Buffer {
  const payload = Buffer.alloc(uncompressedBytes, 0);
  const deflated = zlib.deflateRawSync(payload, { level: 9 });
  const name = Buffer.from('bomb.bin', 'utf8');

  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + deflated.length, 16);

  return Buffer.concat([local, deflated, central, end]);
}

describe('an archive cannot expand without limit', () => {
  it('refuses an entry that would inflate past the limit, before allocating it', () => {
    // 64 MB of zeroes compresses to a few dozen kilobytes. With a 1 MB budget it must be refused —
    // and refused by the inflater, not by checking the size of something already in memory.
    const bomb = zipBomb(64 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => readZip(bomb, 1024 * 1024)).toThrow(/exceeds the|expands beyond/i);
  });

  it('does not trust the size the archive declares', () => {
    // A declared size is attacker-controlled, so the inflater is given the bound as well. Lying low
    // to get past a declared-size check still hits the real one.
    const bomb = zipBomb(8 * 1024 * 1024);
    const tampered = Buffer.from(bomb);
    // Rewrite both copies of the uncompressed size to something small.
    tampered.writeUInt32LE(16, 22);
    const centralAt = tampered.length - 22 - (46 + 8);
    tampered.writeUInt32LE(16, centralAt + 24);
    expect(() => readZip(tampered, 64 * 1024)).toThrow(/expands beyond|could not be decompressed/i);
  });

  it('still reads an ordinary archive', () => {
    const zip = writeZip([{ path: 'a.txt', data: Buffer.from('hello') }]);
    expect(readZip(zip).get('a.txt')!.toString()).toBe('hello');
    // And the default limit is generous enough for a real workbook.
    const book = writeXlsx([{ name: 'S', columns: [{ header: 'a' }], rows: [['1']] }]);
    expect(readXlsx(book)[0].rows[1]).toEqual(['1']);
  });
});

describe('a spreadsheet cannot claim a grid it could not have', () => {
  const workbook = (sheetXml: string): Buffer =>
    writeZip([
      {
        path: 'xl/workbook.xml',
        data: Buffer.from(
          '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
        ),
      },
      {
        path: 'xl/_rels/workbook.xml.rels',
        data: Buffer.from(
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
      },
      { path: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml) },
    ]);

  it('does not allocate two billion rows because a file asked for one', () => {
    // The whole attack in a few hundred bytes. Unbounded, this pushed onto the row array two billion
    // times; bounded, it reads as the next row and returns immediately.
    const file = workbook(
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2000000000"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>',
    );
    expect(file.length).toBeLessThan(4000);
    const started = Date.now();
    const [sheet] = readXlsx(file);
    expect(Date.now() - started, 'read in well under a second').toBeLessThan(2000);
    expect(sheet.rows.length).toBeLessThanOrEqual(1);
    expect(sheet.rows[0][0]).toBe('x');
  });

  it('does not allocate billions of columns either', () => {
    const file = workbook(
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="ZZZZZZZZ1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>',
    );
    const started = Date.now();
    const [sheet] = readXlsx(file);
    expect(Date.now() - started).toBeLessThan(2000);
    // Clamped to the last column a spreadsheet has, rather than a made-up one.
    expect(sheet.rows[0].length).toBeLessThanOrEqual(16_384);
  });

  it('clamps a column reference to the real grid', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('XFD1')).toBe(16_383);
    // Beyond the grid: clamped, not grown.
    expect(columnIndex('ZZZZZZZZ1')).toBe(16_383);
    expect(columnIndex('AAAAAAAAAAAA9')).toBe(16_383);
  });

  it('still reads a workbook with ordinary references', () => {
    const book = writeXlsx([
      {
        name: 'S',
        columns: [{ header: 'a' }, { header: 'b' }],
        rows: [
          ['1', '2'],
          ['3', '4'],
        ],
      },
    ]);
    const [sheet] = readXlsx(book);
    expect(sheet.rows[1]).toEqual(['1', '2']);
    expect(sheet.rows[2]).toEqual(['3', '4']);
  });
});
