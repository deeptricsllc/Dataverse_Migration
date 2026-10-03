import { describe, expect, it } from 'vitest';
import { looksLikeXml, readXml, XmlReadError } from '../../server/src/lib/xml';
import { readSheets } from '../../server/src/services/staged-source-service';

/**
 * Reading an XML extract.
 *
 * The reason this exists is in the first describe block: an XML upload used to be parsed as
 * delimited text, which produced a one-column table of XML fragments that then profiled, mapped
 * and migrated like any other table. A confidently wrong answer is the failure this product is
 * built to prevent, so the regression test comes before the feature tests.
 */

const buf = (s: string) => Buffer.from(s, 'utf8');

const CUSTOMERS = `<?xml version="1.0" encoding="UTF-8"?>
<customers>
  <customer id="C-1" status="active">
    <name>Acme Ltd</name>
    <city>Leeds</city>
  </customer>
  <customer id="C-2" status="dormant">
    <name>Globex</name>
    <city>Derby</city>
  </customer>
</customers>`;

describe('an XML file is never read as something else', () => {
  it('is recognised as XML rather than falling through to the delimited reader', () => {
    expect(looksLikeXml(buf(CUSTOMERS))).toBe(true);
    // No prolog, which is how plenty of real exports arrive.
    expect(looksLikeXml(buf('<orders><order><id>1</id></order></orders>'))).toBe(true);
    // And a CSV whose first field happens to start with a bracket is still a CSV.
    expect(looksLikeXml(buf('name,city\nAcme,Leeds'))).toBe(false);
    expect(looksLikeXml(buf('<not a tag, just text'))).toBe(false);
  });

  it('produces real columns, not one column of XML fragments', () => {
    const [table] = readSheets(buf(CUSTOMERS), 'customers.xml');
    const [headers, ...rows] = table.rows;
    // The old behaviour: headers.length === 1 and every cell a chunk of markup.
    expect(headers.length).toBeGreaterThan(1);
    expect(headers).toEqual(['id', 'status', 'name', 'city']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['C-1', 'active', 'Acme Ltd', 'Leeds']);
    for (const cell of rows.flat()) expect(String(cell)).not.toContain('<');
  });

  it('names the table after the record element', () => {
    expect(readSheets(buf(CUSTOMERS), 'export-2026-09.xml')[0].name).toBe('customer');
  });
});

describe('finding the rows', () => {
  it('descends through wrappers to the element that actually repeats', () => {
    const xml = `<export><meta><run>7</run></meta><orders>
      <order><id>1</id></order><order><id>2</id></order><order><id>3</id></order>
    </orders></export>`;
    const [table] = readXml(buf(xml), 'o.xml');
    // `export` has two children, so the repeated `order` inside `orders` is what a row is.
    expect(table.name).toBe('order');
    expect(table.rows).toHaveLength(4);
  });

  it('reads a single-record document as one row', () => {
    // A per-record file export is a real shape, and one row is the honest reading of it.
    const [table] = readXml(buf('<invoice><number>INV-9</number><total>42.50</total></invoice>'), 'i.xml');
    expect(table.rows[0]).toEqual(['number', 'total']);
    expect(table.rows[1]).toEqual(['INV-9', '42.50']);
  });

  it('refuses a document with no records rather than inventing one', () => {
    expect(() => readXml(buf('<empty/>'), 'e.xml')).toThrow(XmlReadError);
    expect(() => readXml(buf('<empty/>'), 'e.xml')).toThrow(/looks like a repeated record/);
  });
});

describe('flattening a record', () => {
  it('gives nested elements a dotted path and attributes an @ prefix', () => {
    const xml = `<rows>
      <row id="1"><addr type="billing"><city>Leeds</city></addr></row>
      <row id="2"><addr type="postal"><city>Derby</city></addr></row>
    </rows>`;
    const [table] = readXml(buf(xml), 'n.xml');
    expect(table.rows[0]).toEqual(['id', 'addr_type', 'addr_city']);
    expect(table.rows[1]).toEqual(['1', 'billing', 'Leeds']);
  });

  it('takes the union of fields across records, in first-seen order', () => {
    // A later row carrying an extra field is ordinary in an export, not an error. Same rule a
    // SharePoint list already follows.
    const xml = `<rows><row><a>1</a></row><row><a>2</a><b>x</b></row></rows>`;
    const [table] = readXml(buf(xml), 'u.xml');
    expect(table.rows[0]).toEqual(['a', 'b']);
    expect(table.rows[1]).toEqual(['1', null]);
    expect(table.rows[2]).toEqual(['2', 'x']);
  });

  it('keeps every value when a field repeats inside one record', () => {
    // Quietly keeping the last one would lose data without saying so, which is the one thing this
    // product must never do.
    const xml = `<rows><row><tag>a</tag><tag>b</tag><tag>c</tag></row><row><tag>z</tag></row></rows>`;
    const [table] = readXml(buf(xml), 'r.xml');
    expect(table.rows[1]).toEqual(['a; b; c']);
    expect(table.rows[2]).toEqual(['z']);
  });

  it('decodes the standard entities and numeric references', () => {
    const xml = `<rows><row><n>Smith &amp; Sons</n><q>&#65;&#x42;</q></row><row><n>x</n><q>y</q></row></rows>`;
    const [table] = readXml(buf(xml), 'e.xml');
    expect(table.rows[1]).toEqual(['Smith & Sons', 'AB']);
  });

  it('reads CDATA as text and ignores comments', () => {
    const xml = `<rows><row><n><![CDATA[Acme <Ltd>]]></n></row><!-- skip --><row><n>B</n></row></rows>`;
    const [table] = readXml(buf(xml), 'c.xml');
    expect(table.rows[1]).toEqual(['Acme <Ltd>']);
    expect(table.rows).toHaveLength(3);
  });
});

describe('what it refuses', () => {
  it('refuses a document type declaration outright', () => {
    // The billion-laughs shape. Refusing the declaration is simpler to guarantee than bounding
    // every expansion it could describe, and no data extract needs one.
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [ <!ENTITY lol "lol"> <!ENTITY lol2 "&lol;&lol;&lol;&lol;"> ]>
<rows><row><a>&lol2;</a></row><row><a>x</a></row></rows>`;
    expect(() => readXml(buf(bomb), 'b.xml')).toThrow(/document type declaration/);
  });

  it('leaves an unknown entity alone rather than resolving it', () => {
    // Nothing external is ever fetched, so an unresolvable reference stays as written.
    const xml = `<rows><row><a>&xxe;</a></row><row><a>b</a></row></rows>`;
    expect(readXml(buf(xml), 'x.xml').at(0)!.rows[1]).toEqual(['&xxe;']);
  });

  it('names other formats instead of mangling them', () => {
    expect(() => readSheets(buf('{"rows":[{"a":1}]}'), 'data.json')).toThrow(/looks like JSON/);
    expect(() => readSheets(buf('<!DOCTYPE html><html><body>hi</body></html>'), 'p.html')).toThrow(
      /looks like an HTML page/,
    );
    expect(() => readSheets(buf('%PDF-1.7 junk'), 'r.pdf')).toThrow(/looks like a PDF/);
  });

  it('still reads a CSV that begins with an unusual character', () => {
    // The refusals above must not catch real delimited data.
    const [table] = readSheets(buf('name,city\nAcme,Leeds'), 'c.csv');
    expect(table.rows[0]).toEqual(['name', 'city']);
  });
});
