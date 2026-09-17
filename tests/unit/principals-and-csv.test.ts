import { describe, expect, it } from 'vitest';
import type { PrincipalDto } from '../../shared/domain';
import { csvCell, csvFileName, toCsv } from '../../server/src/lib/csv';
import { matchPrincipal } from '../../server/src/services/principal-service';

const user = (p: Partial<PrincipalDto> & { id: string; name: string }): PrincipalDto => ({
  login: null,
  email: null,
  entraObjectId: null,
  disabled: false,
  ...p,
});

describe('principal matching', () => {
  const targets = [
    user({
      id: 't1',
      name: 'Priya Patel',
      login: 'priya@corp.com',
      email: 'priya@corp.com',
      entraObjectId: 'aad-1',
    }),
    user({ id: 't2', name: 'Mateo Garcia', login: 'mateo@corp.com', email: 'mateo.garcia@corp.com' }),
    user({ id: 't3', name: 'Same Name' }),
    user({ id: 't4', name: 'Same Name' }),
  ];

  it('prefers the Entra object id, then login, then email', () => {
    expect(
      matchPrincipal(user({ id: 's1', name: 'P. Patel', entraObjectId: 'AAD-1' }), targets),
    ).toMatchObject({
      targetId: 't1',
      method: 'ENTRA_OBJECT_ID',
      confidence: 100,
    });
    expect(
      matchPrincipal(user({ id: 's2', name: 'Whoever', login: 'MATEO@corp.com' }), targets),
    ).toMatchObject({
      targetId: 't2',
      method: 'LOGIN',
    });
    expect(
      matchPrincipal(user({ id: 's3', name: 'Whoever', email: 'mateo.garcia@corp.com' }), targets),
    ).toMatchObject({ targetId: 't2', method: 'EMAIL' });
  });

  it('accepts a unique name match with lower confidence and flags it', () => {
    const m = matchPrincipal(user({ id: 's4', name: 'Priya Patel' }), targets);
    expect(m).toMatchObject({ targetId: 't1', method: 'NAME', confidence: 70 });
    expect(m.note).toMatch(/display name only/);
  });

  it('never guesses between ambiguous or missing matches', () => {
    const ambiguous = matchPrincipal(user({ id: 's5', name: 'Same Name' }), targets);
    expect(ambiguous).toMatchObject({ targetId: null });
    // The candidates are kept so a human can choose; nothing is applied automatically.
    expect(ambiguous.candidates?.map((c) => c.id)).toEqual(['t3', 't4']);
    expect(matchPrincipal(user({ id: 's6', name: 'Nobody Here' }), targets)).toMatchObject({
      targetId: null,
      confidence: 0,
    });
  });
});

describe('CSV export', () => {
  it('escapes quotes, separators and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(false)).toBe('false');
  });

  it('neutralizes spreadsheet formulas', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvCell('+1-555-0000')).toBe("'+1-555-0000");
    expect(csvCell('@user')).toBe("'@user");
  });

  it('writes a UTF-8 BOM and CRLF rows', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        [1, 'x'],
        [null, 'y,z'],
      ],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('a,b\r\n1,x\r\n,"y,z"\r\n');
  });

  it('builds a safe file name', () => {
    const name = csvFileName(['validation differences', 'DeepTrics QA/Dev']);
    expect(name).toMatch(
      /^validation-differences-deeptrics-qa-dev-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/,
    );
  });
});
