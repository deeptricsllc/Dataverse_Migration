import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_OPTIONS } from '../../shared/domain';
import { analyzeDependencies } from '../../server/src/services/dependency-graph';
import {
  NameSimilaritySuggestionProvider,
  autoMapTable,
  validateManualMapping,
} from '../../server/src/services/mapping';
import { validatePlan, type PlanValidationEntity } from '../../server/src/services/plan-validation';
import { diffTableDeep } from '../../server/src/services/schema-diff';
import { attr, lookup, table } from './fixtures';

describe('field mapping', () => {
  const source = table('account', [
    attr('name', 'String', { maxLength: 100 }),
    attr('score', 'Integer'),
    attr('code', 'String'),
    attr('legacy_note', 'Memo', { displayName: 'Legacy Note' }),
    attr('createdon', 'DateTime', { isValidForCreate: false, isValidForUpdate: false }),
    attr('ownerid', 'Owner', { targets: ['systemuser'] }),
    attr('readonly', 'String'),
    lookup('parentid', ['account']),
  ]);
  const target = table('account', [
    attr('name', 'String', { maxLength: 100 }),
    attr('score', 'Decimal'),
    attr('code', 'Integer'),
    attr('dtx_legacynote', 'Memo', { displayName: 'Legacy Note' }),
    attr('ownerid', 'Owner', { targets: ['systemuser'] }),
    attr('readonly', 'String', { isValidForCreate: false, isValidForUpdate: false }),
    lookup('parentid', ['account']),
  ]);
  const byField = Object.fromEntries(autoMapTable(source, target).map((m) => [m.sourceField, m]));

  it('auto-maps exact logical names with compatible types', () => {
    expect(byField.name).toMatchObject({ status: 'AUTO_MAPPED', confidence: 100 });
    expect(byField.score).toMatchObject({ status: 'AUTO_MAPPED', targetType: 'Decimal' });
    expect(byField.parentid).toMatchObject({
      status: 'AUTO_MAPPED',
      isLookup: true,
      lookupTargets: ['account'],
    });
  });

  it('marks incompatible, read-only, unmapped and system columns', () => {
    expect(byField.code.status).toBe('INCOMPATIBLE');
    expect(byField.readonly).toMatchObject({ status: 'INCOMPATIBLE', reason: 'Target column is read-only' });
    expect(byField.legacy_note.status).toBe('UNMAPPED');
    expect(byField.ownerid.status).toBe('IGNORED');
    expect(byField.createdon).toBeUndefined();
    expect(byField.accountid).toBeUndefined();
  });

  it('validates manual mappings', () => {
    const s = source.attributes.find((a) => a.logicalName === 'legacy_note')!;
    expect(
      validateManualMapping(
        s,
        target.attributes.find((a) => a.logicalName === 'dtx_legacynote'),
      ),
    ).toBeNull();
    expect(
      validateManualMapping(
        s,
        target.attributes.find((a) => a.logicalName === 'score'),
      ),
    ).toMatch(/cannot be converted/);
    expect(validateManualMapping(s, undefined)).toBe('Target column does not exist');
  });

  it('produces suggestions without applying them', async () => {
    const provider = new NameSimilaritySuggestionProvider();
    const suggestions = await provider.suggest({
      source,
      target,
      unmapped: source.attributes.filter((a) => a.logicalName === 'legacy_note'),
      usedTargets: new Set(['name']),
    });
    expect(suggestions).toEqual([
      expect.objectContaining({ sourceField: 'legacy_note', targetField: 'dtx_legacynote' }),
    ]);
  });
});

describe('migration plan validation', () => {
  const entity = (overrides: Partial<PlanValidationEntity>): PlanValidationEntity => {
    const s = overrides.source ?? table('account', [attr('name', 'String')]);
    const t = 'target' in overrides ? overrides.target : s;
    return {
      logicalName: s.logicalName,
      source: s,
      target: t,
      schemaStatus: null,
      tableDiff: s && t ? diffTableDeep(s, t) : null,
      mappings: autoMapTable(s, t),
      sourceCount: 10,
      targetCount: 0,
      matchStrategy: 'PRIMARY_ID',
      alternateKey: null,
      businessKeyFields: [],
      automation: null,
      ...overrides,
    };
  };
  const run = (entities: PlanValidationEntity[], options = DEFAULT_PLAN_OPTIONS, bypassAllowed = false) =>
    validatePlan({
      entities,
      dependencies: analyzeDependencies({
        tables: entities.map((e) => e.source!).filter(Boolean),
        targetTables: new Set(entities.filter((e) => e.target).map((e) => e.logicalName)),
      }),
      options,
      bypassAllowed,
    });

  it('blocks empty plans and tables missing in target', () => {
    expect(run([]).some((i) => i.code === 'NO_TABLES_SELECTED' && i.severity === 'BLOCKER')).toBe(true);
    const issues = run([entity({ target: undefined })]);
    expect(issues.find((i) => i.code === 'TABLE_MISSING_IN_TARGET')!.severity).toBe('BLOCKER');
  });

  it('blocks when a required target column has no mapping', () => {
    const s = table('account', [attr('name', 'String')]);
    const t = table('account', [
      attr('name', 'String'),
      attr('code', 'String', { requiredLevel: 'ApplicationRequired' }),
    ]);
    const issues = run([entity({ source: s, target: t })]);
    expect(issues.find((i) => i.code === 'REQUIRED_TARGET_COLUMN_UNMAPPED')).toMatchObject({
      severity: 'BLOCKER',
      field: 'code',
    });
  });

  it('blocks unresolvable circular dependencies and informs about two-pass ones', () => {
    const a = table('a', [lookup('bid', ['b'], true)]);
    const b = table('b', [lookup('aid', ['a'], true)]);
    expect(
      run([entity({ source: a }), entity({ source: b })]).some(
        (i) => i.code === 'UNRESOLVABLE_CIRCULAR_DEPENDENCY',
      ),
    ).toBe(true);
    const c = table('c', [lookup('parentid', ['c'])]);
    expect(
      run([entity({ source: c })]).find((i) => i.code === 'CIRCULAR_DEPENDENCY_TWO_PASS')!.severity,
    ).toBe('INFO');
  });

  it('warns about schema risks, server-side logic and overwrite strategies', () => {
    const s = table('account', [attr('name', 'String', { maxLength: 200 })]);
    const t = table('account', [attr('name', 'String', { maxLength: 50 })]);
    const issues = run(
      [
        entity({
          source: s,
          target: t,
          targetCount: 5,
          automation: {
            table: 'account',
            pluginSteps: 1,
            workflows: 0,
            flows: 0,
            details: [],
            detectionSupported: true,
          },
        }),
      ],
      { ...DEFAULT_PLAN_OPTIONS, conflictStrategy: 'UPSERT' },
    );
    const codes = issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['SCHEMA_MAXLENGTH', 'SERVER_SIDE_LOGIC', 'UPSERT_OVERWRITES']),
    );
    expect(issues.every((i) => i.severity !== 'BLOCKER')).toBe(true);
  });

  it('only allows business-logic bypass when permitted', () => {
    const options = { ...DEFAULT_PLAN_OPTIONS, bypassCustomBusinessLogic: true };
    expect(run([entity({})], options, false).find((i) => i.code === 'BUSINESS_LOGIC_BYPASS')!.severity).toBe(
      'BLOCKER',
    );
    expect(run([entity({})], options, true).find((i) => i.code === 'BUSINESS_LOGIC_BYPASS')!.severity).toBe(
      'WARNING',
    );
  });

  it('blocks alternate-key matching on keys missing in target', () => {
    const issues = run([entity({ matchStrategy: 'ALTERNATE_KEY', alternateKey: 'nokey' })]);
    expect(issues.find((i) => i.code === 'ALTERNATE_KEY_MISSING')!.severity).toBe('BLOCKER');
  });
});

describe('a source nothing can write into', () => {
  /**
   * An uploaded CSV, a OneDrive file, a SharePoint list.
   *
   * Their inferred columns are marked not-valid-for-create and not-valid-for-update — truthfully, and
   * about the file rather than about the data. The mapping filter used those flags to exclude columns
   * nothing can write, which for a read-only source excluded every one of them: a plan from an upload
   * had no field mappings at all and sat permanently blocked on "required target column has no mapped
   * source column", with nothing available to map.
   *
   * Found by uploading a 1,200-row CSV to deployed QA and pairing it with a target table.
   */
  const uploaded = table('sampling', [
    attr('code', 'String', { isValidForCreate: false, isValidForUpdate: false }),
    attr('full_name', 'String', { isValidForCreate: false, isValidForUpdate: false }),
    attr('city', 'String', { isValidForCreate: false, isValidForUpdate: false }),
    attr('amount', 'Decimal', { isValidForCreate: false, isValidForUpdate: false }),
  ]);
  const product = table('product', [
    attr('name', 'String'),
    attr('productnumber', 'String'),
    attr('price', 'Money', { precision: 2 }),
  ]);

  it('offers every readable column, so the plan can be mapped at all', () => {
    const proposals = autoMapTable(uploaded, product);
    expect(proposals.map((p) => p.sourceField).sort()).toEqual(['amount', 'city', 'code', 'full_name']);
  });

  it('offers the file’s key column too, because in a spreadsheet the key is data', () => {
    /**
     * The second half of the same bug. An upload's "primary id" is whichever column was found to be
     * unique — a product number, a customer reference — and a platform's primary id is a GUID that
     * means nothing elsewhere. Excluding both alike meant an upload could never supply a required
     * target column like `productnumber`: the plan stayed blocked with nothing available to map.
     */
    const keyed = table(
      'sampling',
      [
        attr('code', 'String', {
          isValidForCreate: false,
          isValidForUpdate: false,
          isPrimaryId: true,
          family: 'TABULAR',
        }),
        attr('full_name', 'String', {
          isValidForCreate: false,
          isValidForUpdate: false,
          family: 'TABULAR',
        }),
      ],
      { primaryIdAttribute: 'code' },
    );
    const proposals = autoMapTable(keyed, product);
    expect(proposals.map((p) => p.sourceField).sort()).toContain('code');
  });

  it('still hides a platform primary identifier, which means nothing in another system', () => {
    const dataverse = table('account', [attr('name', 'String')]);
    const proposals = autoMapTable(dataverse, product);
    expect(proposals.map((p) => p.sourceField)).not.toContain('accountid');
  });

  it('still hides a column nothing can write in a source that writes', () => {
    // The rule earns its keep on a Dataverse or SQL source, where a column nothing can write is
    // usually computed or platform-managed and proposing it is noise.
    const dataverse = table('account', [
      attr('name', 'String'),
      attr('calculated', 'Decimal', { isValidForCreate: false, isValidForUpdate: false }),
    ]);
    const proposals = autoMapTable(dataverse, product);
    expect(proposals.map((p) => p.sourceField)).toEqual(['name']);
  });
});
