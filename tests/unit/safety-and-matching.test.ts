import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN_OPTIONS,
  auditFlags,
  auditNeedsImpersonation,
  auditNeedsPrincipals,
  classifyEnvironment,
  type PlanOptions,
} from '../../shared/domain';
import { WebApiConnection } from '../../server/src/dataverse/web-api-connection';
import { describeMatchStrategy } from '../../server/src/services/record-matcher';
import {
  computeChanges,
  decideAction,
  isComparableColumn,
  type PlannerEntity,
  type PreparedRecord,
} from '../../server/src/services/record-planner';
import { attr, table } from './fixtures';

const logger = pino({ level: 'silent' });
const writeOptions = { bypassCustomBusinessLogic: false, suppressFlowTriggers: false };

const unreachableFetch = (async () => {
  throw new Error('no request should leave the process in read-only mode');
}) as unknown as typeof fetch;

describe('REAL_TENANT_READ_ONLY write block', () => {
  const conn = () =>
    new WebApiConnection({
      url: 'https://org.crm.dynamics.com',
      apiVersion: 'v9.2',
      getAccessToken: async () => 't',
      logger,
      readOnly: true,
      fetchImpl: unreachableFetch,
    });
  const account = table('account', [attr('name', 'String', { isPrimaryName: true })]);

  it('refuses creates before any HTTP request is made', async () => {
    await expect(
      conn().createRecord(account, { id: 'a', values: { name: 'X' } }, writeOptions),
    ).rejects.toMatchObject({ code: 'READ_ONLY_MODE', status: 403, retryable: false });
  });

  it('refuses updates, including impersonated ones', async () => {
    await expect(
      conn().updateRecord(
        account,
        '2e7a6f0c-5f1b-4a5d-9f3e-0c7d6b8a1234',
        { id: 'a', values: { name: 'X' } },
        { ...writeOptions, impersonateUserId: '9f1e2d3c-4b5a-6789-0123-456789abcdef' },
      ),
    ).rejects.toMatchObject({ code: 'READ_ONLY_MODE' });
  });

  it('explains why the write was refused without leaking anything else', async () => {
    const err = await conn()
      .createRecord(account, { id: 'a', values: { name: 'X' } }, writeOptions)
      .catch((e: Error) => e);
    expect(String(err)).toContain('REAL_TENANT_READ_ONLY');
    expect(String(err)).toContain('POST');
  });
});

describe('environment safety classification', () => {
  it('flags production environments and never guesses', () => {
    expect(classifyEnvironment('Production')).toBe('PRODUCTION');
    expect(classifyEnvironment('Default')).toBe('PRODUCTION');
    expect(classifyEnvironment('Sandbox')).toBe('NON_PRODUCTION');
    expect(classifyEnvironment('Trial')).toBe('NON_PRODUCTION');
    expect(classifyEnvironment('SomethingNew')).toBe('UNKNOWN');
    expect(classifyEnvironment(null)).toBe('UNKNOWN');
  });
});

describe('audit policy flags', () => {
  it('derives exactly what each policy writes', () => {
    expect(auditFlags('NONE')).toEqual({
      owner: false,
      createdOn: false,
      createdBy: false,
      modifiedBy: false,
    });
    expect(auditFlags('STANDARD')).toMatchObject({ owner: true, createdOn: true, createdBy: false });
    expect(auditFlags('PRESERVE_ATTRIBUTION')).toEqual({
      owner: true,
      createdOn: true,
      createdBy: true,
      modifiedBy: true,
    });
    expect(auditNeedsPrincipals('NONE')).toBe(false);
    expect(auditNeedsPrincipals('STANDARD')).toBe(true);
    expect(auditNeedsImpersonation('STANDARD')).toBe(false);
    expect(auditNeedsImpersonation('PRESERVE_ATTRIBUTION')).toBe(true);
  });

  it('defaults to no attribution writes and to the strict user policy', () => {
    expect(DEFAULT_PLAN_OPTIONS.auditPolicy).toBe('NONE');
    expect(DEFAULT_PLAN_OPTIONS.userResolutionPolicy).toBe('STRICT');
    expect(DEFAULT_PLAN_OPTIONS.fallbackPrincipal).toBeNull();
  });
});

describe('match strategy description', () => {
  it('states per table how records are matched', () => {
    expect(
      describeMatchStrategy({ matchStrategy: 'PRIMARY_ID', alternateKey: null, businessKeyFields: [] }),
    ).toBe('record id (preserved GUID)');
    expect(
      describeMatchStrategy({ matchStrategy: 'ALTERNATE_KEY', alternateKey: 'key1', businessKeyFields: [] }),
    ).toBe('key1 (alternate key)');
    expect(
      describeMatchStrategy({
        matchStrategy: 'BUSINESS_KEY',
        alternateKey: null,
        businessKeyFields: ['name', 'dtx_code'],
      }),
    ).toBe('name + dtx_code (configured business key)');
  });
});

describe('no-op guarantee: identical records produce no write', () => {
  const target = table('dtx_region', [
    attr('dtx_name', 'String', { isPrimaryName: true }),
    attr('dtx_code', 'String'),
    attr('createdon', 'DateTime', { isValidForUpdate: false }),
    attr('ownerid', 'Owner'),
  ]);
  const entity: PlannerEntity = {
    logicalName: 'dtx_region',
    displayName: 'Region',
    targetLogicalName: 'dtx_region',
    orderIndex: 1,
    matchStrategy: 'PRIMARY_ID',
    alternateKey: null,
    businessKeyFields: [],
    mappings: [
      { sourceField: 'dtx_name', targetField: 'dtx_name', isLookup: false, deferredTargets: [] },
      { sourceField: 'dtx_code', targetField: 'dtx_code', isLookup: false, deferredTargets: [] },
    ],
    audit: {
      ownerField: 'ownerid',
      createdOnField: 'createdon',
      createdByField: 'createdby',
      modifiedByField: 'modifiedby',
      overriddenCreatedOnField: 'overriddencreatedon',
      touchField: null,
    },
  };
  const options: PlanOptions = { ...DEFAULT_PLAN_OPTIONS, conflictStrategy: 'SYNC' };
  const prepared: PreparedRecord = {
    sourceId: 's1',
    name: 'North',
    values: { dtx_name: 'North', dtx_code: 'N1' },
    deferred: {},
    principalFallbacks: [],
    appliedTransformations: [],
    lossyFields: [],
    impersonateUserId: null,
    auditWork: null,
    issues: [],
    blocked: null,
  };

  it('never compares platform-stamped audit columns', () => {
    expect(isComparableColumn(entity, 'createdon')).toBe(false);
    expect(isComparableColumn(entity, 'modifiedon')).toBe(false);
    expect(isComparableColumn(entity, 'createdby')).toBe(false);
    expect(isComparableColumn(entity, 'overriddencreatedon')).toBe(false);
    // Ownership is a real, intended change, so it is compared.
    expect(isComparableColumn(entity, 'ownerid')).toBe(true);
    expect(isComparableColumn(entity, 'dtx_name')).toBe(true);
  });

  it('reports UNCHANGED when every mapped value is logically equal', () => {
    const existing = {
      id: 't1',
      values: { dtx_name: 'North', dtx_code: 'N1', createdon: '2020-01-01T00:00:00Z' },
    };
    expect(computeChanges(entity, target, prepared.values, existing)).toHaveLength(0);
    const decision = decideAction(entity, options, target, prepared, {
      target: existing,
      method: 'PRIMARY_ID',
    });
    expect(decision.action).toBe('UNCHANGED');
  });

  it('patches only the columns that actually differ', () => {
    const existing = { id: 't1', values: { dtx_name: 'Old name', dtx_code: 'N1' } };
    const decision = decideAction(entity, options, target, prepared, {
      target: existing,
      method: 'PRIMARY_ID',
    });
    expect(decision.action).toBe('UPDATE');
    if (decision.action !== 'UPDATE') throw new Error('unreachable');
    expect(Object.keys(decision.values)).toEqual(['dtx_name']);
    expect(decision.changes.map((c) => c.field)).toEqual(['dtx_name']);
  });

  it('creates when there is no target record', () => {
    expect(decideAction(entity, options, target, prepared, { target: null, method: null }).action).toBe(
      'CREATE',
    );
  });

  it('reports a conflict instead of guessing between duplicate targets', () => {
    const decision = decideAction(entity, options, target, prepared, {
      target: null,
      method: null,
      conflict: { code: 'AMBIGUOUS_TARGET_MATCH', reason: '2 target records match' },
    });
    expect(decision.action).toBe('CONFLICT');
    if (decision.action !== 'CONFLICT') throw new Error('unreachable');
    expect(decision.code).toBe('AMBIGUOUS_TARGET_MATCH');
  });

  it('never modifies an existing record under SKIP_EXISTING', () => {
    const decision = decideAction(
      entity,
      { ...options, conflictStrategy: 'SKIP_EXISTING' },
      target,
      prepared,
      { target: { id: 't1', values: { dtx_name: 'Old' } }, method: 'PRIMARY_ID' },
    );
    expect(decision.action).toBe('SKIP');
  });
});
