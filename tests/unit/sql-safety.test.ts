import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../../server/src/lib/crypto';
import { quoteIdent, SqlConnector } from '../../server/src/connectors/sql/sql-connector';
import { normalizeTableName, proposeObjectMapping } from '../../server/src/services/object-mapping';
import { applyChoiceMap, applyTransform, transformFieldValue } from '../../server/src/services/transforms';
import type { SqlConnectionConfig } from '../../shared/domain';
import { attr, table } from './fixtures';

const logger = pino({ level: 'silent' });

const config: SqlConnectionConfig = {
  host: 'sql01',
  port: 1433,
  database: 'IIC',
  authType: 'SQL_LOGIN',
  username: 'iic_migration',
  encrypt: true,
  trustServerCertificate: false,
  transport: 'DIRECT',
  schemas: [],
};

/** Captures the SQL text and bound parameters instead of talking to a server. */
function recordingConnector(rows: Record<string, unknown>[] = []) {
  const statements: { text: string; params: Record<string, unknown> }[] = [];
  const connector = new SqlConnector({ config, password: 'hunter2', logger });
  // The pool is never created: the request path is replaced with a recorder.
  (connector as unknown as { query: unknown }).query = async (
    text: string,
    params: Record<string, unknown> = {},
  ) => {
    statements.push({ text, params });
    return rows;
  };
  return { connector, statements };
}

describe('SQL identifiers', () => {
  it('brackets an ordinary identifier', () => {
    expect(quoteIdent('Customer')).toBe('[Customer]');
    expect(quoteIdent('Order Details')).toBe('[Order Details]');
    expect(quoteIdent('dbo.Customer')).toBe('[dbo.Customer]');
  });

  it('refuses anything that is not an identifier', () => {
    for (const bad of [
      'Customer; DROP TABLE Users--',
      "Customer' OR 1=1",
      'Customer/*',
      // A bracket is refused rather than escaped: see quoteIdent.
      'weird]name',
      'a'.repeat(129),
      '',
    ]) {
      expect(() => quoteIdent(bad), bad).toThrow(/Unsupported SQL identifier/);
    }
  });
});

describe('parameterized statements', () => {
  const customer = table('dbo.Customer', [
    attr('CustomerName', 'String', { maxLength: 200 }),
    attr('CustomerNumber', 'String', { maxLength: 20 }),
  ]);

  it('binds source values instead of concatenating them into SQL', async () => {
    const { connector, statements } = recordingConnector();
    const hostile = "'; DROP TABLE [dbo].[Customer]; --";
    await connector.findByFields(customer, { CustomerNumber: hostile }, ['CustomerName'], 2);

    const [statement] = statements;
    // The value appears only as a bound parameter, never in the statement text.
    expect(statement.text).not.toContain('DROP TABLE');
    expect(statement.text).toContain('[CustomerNumber] = @p0');
    expect(statement.params.p0).toBe(hostile);
  });

  it('keys every update on the primary key', async () => {
    const { connector, statements } = recordingConnector([{ affected: 1 }]);
    await connector.updateRecord(
      customer,
      '42',
      { values: { CustomerName: 'New name' } },
      { bypassCustomBusinessLogic: false, suppressFlowTriggers: false },
    );
    const [statement] = statements;
    expect(statement.text).toMatch(/UPDATE \[dbo\]\.\[Customer\] SET \[CustomerName\] = @c0/);
    expect(statement.text).toContain('WHERE [dbo.Customerid] = @recordKey');
    expect(statement.params.recordKey).toBe(42);
  });

  it('sends no statement at all when an update would change nothing', async () => {
    const { connector, statements } = recordingConnector();
    await connector.updateRecord(
      customer,
      '42',
      { values: {} },
      { bypassCustomBusinessLogic: false, suppressFlowTriggers: false },
    );
    expect(statements).toHaveLength(0);
  });

  it('pages by primary key rather than by offset', async () => {
    const { connector, statements } = recordingConnector([{ 'dbo.Customerid': 7, CustomerName: 'A' }]);
    const pages = connector.queryRecords(customer, ['CustomerName'], { pageSize: 500 });
    await pages.next();
    expect(statements[0].text).toContain('SELECT TOP (500)');
    expect(statements[0].text).toContain('ORDER BY [dbo.Customerid]');
    expect(statements[0].text).not.toContain('OFFSET');
  });
});

describe('credential handling', () => {
  it('never puts the password in the connection identity', () => {
    const connector = new SqlConnector({ config, password: 'hunter2', logger });
    expect(connector.url).toBe('sql01:1433/IIC');
    expect(JSON.stringify(connector.url)).not.toContain('hunter2');
  });

  it('redacts a password that a driver error echoes back', () => {
    const connector = new SqlConnector({ config, password: 'hunter2', logger });
    const err = (connector as unknown as { toError: (e: unknown, a: string) => Error }).toError(
      { message: 'Failed to connect: server=sql01;password=hunter2;database=IIC', number: 4060 },
      'connect',
    );
    expect(err.message).not.toContain('hunter2');
    expect(err.message).toContain('password=***');
  });

  it('encrypts a stored credential and detects tampering', () => {
    const box = new SecretBox('a'.repeat(48), 'connection-credentials');
    const ciphertext = box.encrypt('hunter2');
    expect(ciphertext).not.toContain('hunter2');
    expect(box.decrypt(ciphertext)).toBe('hunter2');
    const tampered = `${ciphertext.slice(0, -2)}xx`;
    expect(() => box.decrypt(tampered)).toThrow();
  });
});

describe('table mapping proposals', () => {
  const targets = [
    { logicalName: 'account', displayName: 'Account' },
    { logicalName: 'contact', displayName: 'Contact' },
    { logicalName: 'dtx_region', displayName: 'Region' },
  ].map((t) => ({ ...table(t.logicalName, []), displayName: t.displayName }));

  it('normalizes names across the naming conventions of both systems', () => {
    expect(normalizeTableName('dbo.Customer')).toBe('customer');
    expect(normalizeTableName('dtx_region')).toBe('region');
    expect(normalizeTableName('config.Regions')).toBe('region');
    expect(normalizeTableName('dbo.Companies')).toBe('company');
  });

  it('pairs an identical name immediately', () => {
    const proposal = proposeObjectMapping(table('account', []), targets);
    expect(proposal).toMatchObject({ targetLogicalName: 'account', status: 'EXACT' });
  });

  it('only suggests a different name, never confirms it', () => {
    const proposal = proposeObjectMapping({ ...table('dbo.Region', []), displayName: 'Region' }, targets);
    expect(proposal.status).toBe('AUTO_SUGGESTED');
    expect(proposal.targetLogicalName).toBe('dtx_region');
    expect(proposal.candidates[0].confidence).toBeGreaterThan(50);
  });

  it('leaves a table with no plausible target unmapped', () => {
    const proposal = proposeObjectMapping(
      { ...table('dbo.ZzzInternalLedgerScratch', []), displayName: 'ZzzInternalLedgerScratch' },
      targets,
    );
    expect(proposal).toMatchObject({ targetLogicalName: null, status: 'UNMAPPED' });
  });

  it('never proposes a view as a target', () => {
    const withView = [...targets, { ...table('vw_Accounts', []), isView: true }];
    const proposal = proposeObjectMapping(
      { ...table('dbo.Accounts', []), displayName: 'Accounts' },
      withView,
    );
    expect(proposal.candidates.some((c) => c.logicalName === 'vw_Accounts')).toBe(false);
  });
});

describe('transformations and choice mapping', () => {
  it('applies the configured transformation before anything else', () => {
    expect(applyTransform('  spaced  ', { kind: 'TRIM' })).toBe('spaced');
    expect(applyTransform('abc', { kind: 'UPPER' })).toBe('ABC');
    expect(applyTransform(null, { kind: 'DEFAULT_IF_NULL', value: 'unknown' })).toBe('unknown');
    expect(applyTransform('kept', { kind: 'DEFAULT_IF_NULL', value: 'unknown' })).toBe('kept');
    expect(applyTransform('anything', { kind: 'CONSTANT', value: 42 })).toBe(42);
  });

  it('maps a source value to a target choice, and reports one it cannot', () => {
    const choiceMap = {
      entries: [
        { sourceValue: 'ACTIVE', targetValue: 1, targetLabel: 'Active', status: 'CONFIRMED' as const },
        { sourceValue: 'LEGACY', targetValue: null, targetLabel: null, status: 'UNMAPPED' as const },
      ],
      defaultTargetValue: null,
    };
    expect(applyChoiceMap('ACTIVE', choiceMap)).toEqual({ ok: true, value: 1 });
    // Case-insensitive, because a legacy database rarely agrees with itself about case.
    expect(applyChoiceMap('active', choiceMap)).toEqual({ ok: true, value: 1 });
    expect(applyChoiceMap('LEGACY', choiceMap)).toMatchObject({ ok: false, code: 'VALUE_MAP_MISSING' });
    expect(applyChoiceMap('NEVER SEEN', choiceMap)).toMatchObject({ ok: false, code: 'VALUE_MAP_MISSING' });
    expect(applyChoiceMap(null, choiceMap)).toEqual({ ok: true, value: null });
  });

  it('uses a configured default only when one was chosen', () => {
    const withDefault = {
      entries: [{ sourceValue: 'ACTIVE', targetValue: 1, targetLabel: 'A', status: 'CONFIRMED' as const }],
      defaultTargetValue: 9,
    };
    expect(applyChoiceMap('SOMETHING ELSE', withDefault)).toEqual({ ok: true, value: 9 });
  });

  it('refuses a value that is too long for the target column', () => {
    const source = attr('Notes', 'String', { maxLength: 400 });
    const target = attr('description', 'String', { maxLength: 100 });
    const result = transformFieldValue({ value: 'x'.repeat(150), source, target });
    expect(result).toMatchObject({ ok: false, code: 'STRING_TOO_LONG' });
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('150 characters, target allows 100');
  });
});
