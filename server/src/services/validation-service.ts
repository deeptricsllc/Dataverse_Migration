import { and, asc, count, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import type {
  DifferenceType,
  ValidationCheckDto,
  ValidationDifferenceDto,
  ValidationEntityResultDto,
  ValidationOutcome,
  ValidationRunDto,
  ValidationSummary,
} from '../../../shared/domain';
import { LOOKUP_TYPES, isLookupValue, type DvRecord, type TableMetadata } from '../../../shared/metadata';
import type { AppDb } from '../db/client';
import {
  environments,
  migrationRecordMaps,
  migrationRuns,
  users,
  validationDifferences,
  validationEntityResults,
  validationRuns,
} from '../db/schema';
import type { ConnectionFactory } from '../dataverse/factory';
import type { DataverseConnection } from '../dataverse/types';
import type { JobQueue } from '../jobs/queue';
import { badRequest, errorMessage, notFound } from '../lib/errors';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import type { EnvironmentService } from './environment-service';
import type { MetadataService } from './metadata-service';
import type { RunPlanSnapshot } from './run-snapshot';
import { diffTableDeep } from './schema-diff';
import { displayValue, transformValue, valuesEqual } from './values';

const envRef = (e: { id: string; displayName: string; url: string }) => ({ id: e.id, displayName: e.displayName, url: e.url });
const RANK: Record<ValidationOutcome, number> = { PASS: 0, WARNING: 1, FAIL: 2 };
const worst = (outcomes: ValidationOutcome[]): ValidationOutcome =>
  outcomes.reduce<ValidationOutcome>((w, o) => (RANK[o] > RANK[w] ? o : w), 'PASS');

/** Maximum records compared field-by-field per table (reported when sampling applies). */
const MAX_RECORDS_PER_TABLE = 5000;
const MAX_DIFFERENCES_PER_TABLE = 2000;

interface PendingDiff {
  sourceRecordId: string | null;
  targetRecordId: string | null;
  field: string | null;
  sourceValue: string | null;
  targetValue: string | null;
  differenceType: DifferenceType;
  outcome: ValidationOutcome;
}

export interface EntityComparisonInput {
  source: TableMetadata;
  target: TableMetadata;
  mappings: { sourceField: string; targetField: string; isLookup: boolean }[];
  /** Records to compare: source record, target record (if found) and how it was migrated. */
  pairs: { source: DvRecord; target: DvRecord | null; outcome: 'CREATED' | 'UPDATED' | 'SKIPPED' | 'FAILED' | 'UNMAPPED' }[];
  /** Resolves a source lookup to the expected target id (null = unknown). */
  expectedLookup: (logicalName: string, sourceId: string) => string | null;
}

/**
 * Pure field-level comparison used by the validation engine. Values are normalized so that
 * formatting-only differences (line endings, trailing whitespace, GUID case, precision,
 * date formatting) do not register as mismatches.
 */
export function compareRecords(input: EntityComparisonInput): { matched: number; missing: number; different: number; diffs: PendingDiff[] } {
  const sAttrs = new Map(input.source.attributes.map((a) => [a.logicalName, a]));
  const tAttrs = new Map(input.target.attributes.map((a) => [a.logicalName, a]));
  const diffs: PendingDiff[] = [];
  let matched = 0;
  let missing = 0;
  let different = 0;
  for (const pair of input.pairs) {
    if (!pair.target) {
      missing++;
      diffs.push({
        sourceRecordId: pair.source.id,
        targetRecordId: null,
        field: null,
        sourceValue: null,
        targetValue: null,
        differenceType: 'MISSING_IN_TARGET',
        outcome: 'FAIL',
      });
      continue;
    }
    const preExisting = pair.outcome === 'SKIPPED';
    let recordDiffers = false;
    for (const m of input.mappings) {
      const sAttr = sAttrs.get(m.sourceField);
      const tAttr = tAttrs.get(m.targetField);
      if (!sAttr || !tAttr) continue;
      const sv = pair.source.values[m.sourceField];
      const tv = pair.target.values[m.targetField];
      if (LOOKUP_TYPES.has(tAttr.type)) {
        const expected = isLookupValue(sv) ? input.expectedLookup(sv.logicalName, sv.id) : null;
        const actual = isLookupValue(tv) ? tv.id.toLowerCase() : null;
        // Unresolvable source references were reported during migration; only compare known ones.
        if (isLookupValue(sv) && expected === null) continue;
        if ((expected ?? null) !== actual) {
          recordDiffers = true;
          diffs.push({
            sourceRecordId: pair.source.id,
            targetRecordId: pair.target.id,
            field: m.targetField,
            sourceValue: expected ? `${(sv as { logicalName: string }).logicalName}(${expected})` : null,
            targetValue: displayValue(tAttr, tv),
            differenceType: preExisting ? 'PRE_EXISTING_DIFFERENCE' : 'LOOKUP_MISMATCH',
            outcome: preExisting ? 'WARNING' : 'FAIL',
          });
        }
        continue;
      }
      const converted = transformValue(sAttr, tAttr, sv);
      const expectedValue = converted.ok ? converted.value : sv;
      if (!valuesEqual(tAttr, expectedValue, tv)) {
        recordDiffers = true;
        diffs.push({
          sourceRecordId: pair.source.id,
          targetRecordId: pair.target.id,
          field: m.targetField,
          sourceValue: displayValue(sAttr, sv),
          targetValue: displayValue(tAttr, tv),
          differenceType: preExisting ? 'PRE_EXISTING_DIFFERENCE' : 'VALUE_MISMATCH',
          outcome: preExisting ? 'WARNING' : 'FAIL',
        });
      }
    }
    if (recordDiffers) different++;
    else matched++;
  }
  return { matched, missing, different, diffs };
}

export class ValidationService {
  constructor(
    private readonly db: AppDb,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  async start(
    ctx: RequestContext,
    input: { migrationRunId?: string; sourceEnvironmentId?: string; targetEnvironmentId?: string; tables?: string[] },
  ): Promise<ValidationRunDto> {
    let sourceId: string;
    let targetId: string;
    let tables: string[];
    let migrationRunId: string | null = null;
    if (input.migrationRunId) {
      const [run] = await this.db
        .select()
        .from(migrationRuns)
        .where(and(eq(migrationRuns.id, input.migrationRunId), eq(migrationRuns.organizationId, ctx.organizationId)));
      if (!run) throw notFound('Migration run');
      if (['QUEUED', 'RUNNING'].includes(run.status)) throw badRequest('Wait for the migration run to finish before validating');
      sourceId = run.sourceEnvironmentId;
      targetId = run.targetEnvironmentId;
      tables = run.planSnapshot.entities.map((e) => e.logicalName);
      migrationRunId = run.id;
    } else {
      if (!input.sourceEnvironmentId || !input.targetEnvironmentId || !input.tables?.length) {
        throw badRequest('Provide a migration run, or source, target and tables');
      }
      if (input.sourceEnvironmentId === input.targetEnvironmentId) throw badRequest('Source and target must be different environments');
      sourceId = input.sourceEnvironmentId;
      targetId = input.targetEnvironmentId;
      tables = [...new Set(input.tables)];
    }
    await this.environmentsSvc.getAccessible(ctx, sourceId);
    await this.environmentsSvc.getAccessible(ctx, targetId);
    const [row] = await this.db
      .insert(validationRuns)
      .values({
        organizationId: ctx.organizationId,
        migrationRunId,
        sourceEnvironmentId: sourceId,
        targetEnvironmentId: targetId,
        tables,
        createdByUserId: ctx.userId,
        progressMessage: 'Queued',
      })
      .returning();
    await this.queue.enqueue('VALIDATION', ctx.organizationId, row.id);
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'VALIDATION_REQUESTED',
      outcome: 'REQUESTED',
      sourceEnvironmentId: sourceId,
      targetEnvironmentId: targetId,
      runId: row.id,
      requestId: ctx.requestId,
      details: { migrationRunId, tables },
    });
    return this.get(ctx, row.id);
  }

  async execute(validationRunId: string, heartbeat: () => Promise<void> = async () => {}): Promise<void> {
    const [vr] = await this.db.select().from(validationRuns).where(eq(validationRuns.id, validationRunId));
    if (!vr || vr.status === 'COMPLETED' || vr.status === 'FAILED') return;
    const log = this.logger.child({ validationRunId, migrationRunId: vr.migrationRunId });
    const progress = (progressMessage: string) => this.db.update(validationRuns).set({ progressMessage }).where(eq(validationRuns.id, validationRunId));
    await this.db.update(validationRuns).set({ status: 'RUNNING', startedAt: new Date() }).where(eq(validationRuns.id, validationRunId));
    await this.db.delete(validationEntityResults).where(eq(validationEntityResults.validationRunId, validationRunId));
    await this.db.delete(validationDifferences).where(eq(validationDifferences.validationRunId, validationRunId));
    log.info({ tables: vr.tables }, 'Validation started');
    try {
      if (!vr.createdByUserId) throw new Error('Validation has no initiating user');
      const source = await this.environmentsSvc.getInOrganization(vr.organizationId, vr.sourceEnvironmentId);
      const target = await this.environmentsSvc.getInOrganization(vr.organizationId, vr.targetEnvironmentId);
      const sConn = this.connections.forEnvironment(source, vr.createdByUserId, { validationRunId });
      const tConn = this.connections.forEnvironment(target, vr.createdByUserId, { validationRunId });
      const snapshot: RunPlanSnapshot | null = vr.migrationRunId
        ? ((await this.db.select({ s: migrationRuns.planSnapshot }).from(migrationRuns).where(eq(migrationRuns.id, vr.migrationRunId)))[0]?.s ?? null)
        : null;

      await progress('Loading metadata');
      const targetCatalog = await this.metadata.getCatalog(target.id, tConn, true);
      const sourceMeta = await this.metadata.getTables(source.id, sConn, vr.tables, { refresh: true });
      const referenced = new Set(vr.tables);
      for (const t of sourceMeta.values()) for (const a of t.attributes) if (LOOKUP_TYPES.has(a.type)) (a.targets ?? []).forEach((x) => referenced.add(x));
      const targetMeta = await this.metadata.getTables(
        target.id,
        tConn,
        [...referenced].filter((n) => targetCatalog.some((c) => c.logicalName === n)),
        { refresh: true },
      );
      this.metadata.invalidateCounts(source.id);
      this.metadata.invalidateCounts(target.id);

      const results: ValidationEntityResultDto[] = [];
      for (const [i, table] of vr.tables.entries()) {
        await progress(`Validating ${table} (${i + 1}/${vr.tables.length})`);
        const result = await this.validateEntity({
          vr,
          table,
          source: sourceMeta.get(table),
          target: targetMeta.get(table),
          targetMeta,
          snapshotEntity: snapshot?.entities.find((e) => e.logicalName === table) ?? null,
          sConn,
          tConn,
          sourceEnvId: source.id,
          targetEnvId: target.id,
        });
        results.push(result);
        await heartbeat();
      }

      const summary: ValidationSummary = {
        tablesValidated: results.length,
        sourceRows: results.reduce((n, r) => n + (r.sourceCount ?? 0), 0),
        targetRows: results.reduce((n, r) => n + (r.targetCount ?? 0), 0),
        migratedRows: results.reduce((n, r) => n + r.migratedRecords, 0),
        matchedRecords: results.reduce((n, r) => n + r.matched, 0),
        missingRecords: results.reduce((n, r) => n + r.missing, 0),
        differentRecords: results.reduce((n, r) => n + r.different, 0),
        brokenReferences: results.reduce((n, r) => n + r.brokenReferences, 0),
        pass: results.filter((r) => r.outcome === 'PASS').length,
        warning: results.filter((r) => r.outcome === 'WARNING').length,
        fail: results.filter((r) => r.outcome === 'FAIL').length,
      };
      const outcome = worst(results.map((r) => r.outcome));
      await this.db
        .update(validationRuns)
        .set({ status: 'COMPLETED', outcome, summary, completedAt: new Date(), progressMessage: 'Completed' })
        .where(eq(validationRuns.id, validationRunId));
      await this.audit.record({
        organizationId: vr.organizationId,
        userId: vr.createdByUserId,
        action: 'VALIDATION_COMPLETED',
        outcome: 'SUCCESS',
        sourceEnvironmentId: vr.sourceEnvironmentId,
        targetEnvironmentId: vr.targetEnvironmentId,
        runId: validationRunId,
        details: { outcome, ...summary },
      });
      log.info({ outcome, summary }, 'Validation completed');
    } catch (err) {
      const message = errorMessage(err);
      log.error({ error: message }, 'Validation failed');
      await this.db
        .update(validationRuns)
        .set({ status: 'FAILED', errorMessage: message.slice(0, 2000), completedAt: new Date(), progressMessage: 'Failed' })
        .where(eq(validationRuns.id, validationRunId));
      await this.audit.record({
        organizationId: vr.organizationId,
        userId: vr.createdByUserId,
        action: 'VALIDATION_COMPLETED',
        outcome: 'FAILURE',
        sourceEnvironmentId: vr.sourceEnvironmentId,
        targetEnvironmentId: vr.targetEnvironmentId,
        runId: validationRunId,
        details: { error: message },
      });
    }
  }

  private async validateEntity(p: {
    vr: typeof validationRuns.$inferSelect;
    table: string;
    source: TableMetadata | undefined;
    target: TableMetadata | undefined;
    targetMeta: Map<string, TableMetadata>;
    snapshotEntity: RunPlanSnapshot['entities'][number] | null;
    sConn: DataverseConnection;
    tConn: DataverseConnection;
    sourceEnvId: string;
    targetEnvId: string;
  }): Promise<ValidationEntityResultDto> {
    const { vr, table, source, target } = p;
    const checks: ValidationCheckDto[] = [];
    const diffs: PendingDiff[] = [];
    const base: ValidationEntityResultDto = {
      logicalName: table,
      displayName: source?.displayName ?? target?.displayName ?? table,
      outcome: 'PASS',
      sourceCount: null,
      targetCount: null,
      migratedRecords: 0,
      checkedRecords: 0,
      matched: 0,
      missing: 0,
      different: 0,
      brokenReferences: 0,
      checks,
    };

    // 1. Schema
    if (!source || !target) {
      checks.push({ check: 'SCHEMA', outcome: 'FAIL', message: `Table is missing in the ${!source ? 'source' : 'target'} environment` });
      return this.saveEntity(vr.id, { ...base, outcome: 'FAIL' }, diffs);
    }
    const tableDiff = diffTableDeep(source, target);
    const breaking = tableDiff.columns.filter((c) => c.status === 'INCOMPATIBLE' || c.differences.some((d) => d.breaking));
    checks.push(
      tableDiff.status === 'MATCH'
        ? { check: 'SCHEMA', outcome: 'PASS', message: 'Schemas match' }
        : {
            check: 'SCHEMA',
            outcome: 'WARNING',
            message: `${tableDiff.columns.filter((c) => c.status !== 'MATCH').length} column difference(s)${breaking.length ? `, ${breaking.length} potentially breaking (${breaking.map((b) => b.logicalName).join(', ')})` : ''}`,
          },
    );

    // 2. Row counts
    const [sc, tc] = await Promise.all([p.sConn.countRecords(source), p.tConn.countRecords(target)]);
    base.sourceCount = sc.count;
    base.targetCount = tc.count;
    const approx = sc.approximate || tc.approximate ? ' (approximate)' : '';
    checks.push(
      tc.count === sc.count
        ? { check: 'ROW_COUNT', outcome: 'PASS', message: `Row counts match: ${sc.count}${approx}` }
        : tc.count > sc.count
          ? { check: 'ROW_COUNT', outcome: 'WARNING', message: `Target has ${tc.count - sc.count} more row(s) than source (${tc.count} vs ${sc.count})${approx}` }
          : { check: 'ROW_COUNT', outcome: 'FAIL', message: `Target has ${sc.count - tc.count} fewer row(s) than source (${tc.count} vs ${sc.count})${approx}` },
    );

    // Identity map for this migration run (or ID-based matching without one).
    const maps = vr.migrationRunId
      ? await this.db
          .select()
          .from(migrationRecordMaps)
          .where(and(eq(migrationRecordMaps.runId, vr.migrationRunId), eq(migrationRecordMaps.logicalName, table)))
          .orderBy(asc(migrationRecordMaps.sourceId))
      : [];
    const mappings =
      p.snapshotEntity?.mappings ??
      source.attributes
        .filter((a) => !a.attributeOf && !a.isPrimaryId && a.isValidForCreate && target.attributes.some((t) => t.logicalName === a.logicalName && t.type === a.type))
        .filter((a) => !['ownerid', 'statecode', 'statuscode', 'createdon', 'modifiedon'].includes(a.logicalName))
        .map((a) => ({ sourceField: a.logicalName, targetField: a.logicalName, isLookup: LOOKUP_TYPES.has(a.type) }));

    let pairs: EntityComparisonInput['pairs'] = [];
    const failedMaps = maps.filter((m) => m.outcome === 'FAILED');
    const migrated = maps.filter((m) => m.outcome !== 'FAILED' && m.targetId);
    base.migratedRecords = migrated.length;

    const sampled = migrated.slice(0, MAX_RECORDS_PER_TABLE);
    if (vr.migrationRunId) {
      const sourceRecords = await this.fetchByIds(p.sConn, source, sampled.map((m) => m.sourceId), mappings.map((m) => m.sourceField));
      const targetRecords = await this.fetchByIds(p.tConn, target, sampled.map((m) => m.targetId!), mappings.map((m) => m.targetField));
      pairs = sampled
        .filter((m) => sourceRecords.has(m.sourceId))
        .map((m) => ({ source: sourceRecords.get(m.sourceId)!, target: targetRecords.get(m.targetId!.toLowerCase()) ?? null, outcome: m.outcome }));
    } else {
      // Without a run: compare records by identical primary id (sample).
      const sample: DvRecord[] = [];
      for await (const page of p.sConn.queryRecords(source, mappings.map((m) => m.sourceField), { pageSize: 500 })) {
        sample.push(...page);
        if (sample.length >= MAX_RECORDS_PER_TABLE) break;
      }
      const targetRecords = await this.fetchByIds(p.tConn, target, sample.map((r) => r.id), mappings.map((m) => m.targetField));
      pairs = sample.map((r) => ({ source: r, target: targetRecords.get(r.id.toLowerCase()) ?? null, outcome: 'UNMAPPED' as const }));
    }

    // Expected lookup targets: identity maps for the environment pair, else same id.
    const lookupIds = new Map<string, Set<string>>();
    for (const pair of pairs) {
      for (const m of mappings.filter((x) => x.isLookup)) {
        const v = pair.source.values[m.sourceField];
        if (isLookupValue(v)) {
          if (!lookupIds.has(v.logicalName)) lookupIds.set(v.logicalName, new Set());
          lookupIds.get(v.logicalName)!.add(v.id.toLowerCase());
        }
      }
    }
    const expected = new Map<string, string>();
    for (const [logicalName, ids] of lookupIds) {
      const idList = [...ids];
      for (let i = 0; i < idList.length; i += 500) {
        const chunk = idList.slice(i, i + 500);
        const rows = await this.db
          .select({ sourceId: migrationRecordMaps.sourceId, targetId: migrationRecordMaps.targetId })
          .from(migrationRecordMaps)
          .where(
            and(
              eq(migrationRecordMaps.organizationId, vr.organizationId),
              eq(migrationRecordMaps.sourceEnvironmentId, vr.sourceEnvironmentId),
              eq(migrationRecordMaps.targetEnvironmentId, vr.targetEnvironmentId),
              eq(migrationRecordMaps.logicalName, logicalName),
              inArray(migrationRecordMaps.sourceId, chunk),
              ne(migrationRecordMaps.outcome, 'FAILED'),
              isNotNull(migrationRecordMaps.targetId),
            ),
          )
          .orderBy(desc(migrationRecordMaps.updatedAt));
        for (const r of rows) if (!expected.has(`${logicalName}:${r.sourceId}`)) expected.set(`${logicalName}:${r.sourceId}`, r.targetId!);
      }
      const unresolved = idList.filter((id) => !expected.has(`${logicalName}:${id}`));
      const tTable = p.targetMeta.get(logicalName);
      if (unresolved.length && tTable) {
        const found = await p.tConn.retrieveByIds(tTable, unresolved, []);
        for (const f of found) expected.set(`${logicalName}:${f.id.toLowerCase()}`, f.id.toLowerCase());
      }
    }

    // 3 + 4. Existence and field values
    const cmp = compareRecords({
      source,
      target,
      mappings,
      pairs,
      expectedLookup: (logicalName, id) => expected.get(`${logicalName}:${id.toLowerCase()}`) ?? null,
    });
    diffs.push(...cmp.diffs);
    for (const f of failedMaps) {
      diffs.push({
        sourceRecordId: f.sourceId,
        targetRecordId: null,
        field: null,
        sourceValue: null,
        targetValue: 'Record failed to migrate',
        differenceType: 'MISSING_IN_TARGET',
        outcome: 'FAIL',
      });
    }
    base.checkedRecords = pairs.length;
    base.matched = cmp.matched;
    base.missing = cmp.missing + failedMaps.length;
    base.different = cmp.different;
    const sampleNote = migrated.length > MAX_RECORDS_PER_TABLE ? ` (first ${MAX_RECORDS_PER_TABLE} of ${migrated.length} checked)` : '';
    if (vr.migrationRunId) {
      checks.push(
        base.missing === 0
          ? { check: 'RECORD_EXISTENCE', outcome: 'PASS', message: `All ${pairs.length} migrated record(s) exist in the target${sampleNote}` }
          : {
              check: 'RECORD_EXISTENCE',
              outcome: 'FAIL',
              message: `${base.missing} record(s) missing in target (${failedMaps.length} failed during migration, ${cmp.missing} not found)${sampleNote}`,
            },
      );
    } else {
      checks.push({
        check: 'RECORD_EXISTENCE',
        outcome: cmp.missing === 0 ? 'PASS' : 'FAIL',
        message: `${pairs.length - cmp.missing} of ${pairs.length} source record(s) found in target by identifier${cmp.missing ? `; ${cmp.missing} missing` : ''}`,
      });
    }
    const valueFails = cmp.diffs.filter((d) => d.differenceType === 'VALUE_MISMATCH' || d.differenceType === 'LOOKUP_MISMATCH').length;
    const preExisting = cmp.diffs.filter((d) => d.differenceType === 'PRE_EXISTING_DIFFERENCE').length;
    checks.push(
      valueFails > 0
        ? { check: 'FIELD_VALUES', outcome: 'FAIL', message: `${valueFails} field mismatch(es) across ${cmp.different} record(s)` }
        : preExisting > 0
          ? { check: 'FIELD_VALUES', outcome: 'WARNING', message: `${preExisting} difference(s) on pre-existing target records that were skipped` }
          : { check: 'FIELD_VALUES', outcome: 'PASS', message: `${cmp.matched} record(s) match on ${mappings.length} mapped column(s)` },
    );

    // 5. References: every lookup on checked target records must point at an existing record.
    const refIds = new Map<string, Map<string, string[]>>();
    for (const pair of pairs) {
      if (!pair.target) continue;
      for (const m of mappings.filter((x) => x.isLookup)) {
        const v = pair.target.values[m.targetField];
        if (!isLookupValue(v)) continue;
        if (!refIds.has(v.logicalName)) refIds.set(v.logicalName, new Map());
        const byId = refIds.get(v.logicalName)!;
        byId.set(v.id.toLowerCase(), [...(byId.get(v.id.toLowerCase()) ?? []), `${pair.target.id}|${m.targetField}|${pair.source.id}`]);
      }
    }
    let broken = 0;
    for (const [logicalName, byId] of refIds) {
      const tTable = p.targetMeta.get(logicalName);
      const ids = [...byId.keys()];
      const found = new Set<string>();
      if (tTable) (await p.tConn.retrieveByIds(tTable, ids, [])).forEach((r) => found.add(r.id.toLowerCase()));
      for (const id of ids.filter((x) => !found.has(x))) {
        for (const ref of byId.get(id)!) {
          const [targetRecordId, field, sourceRecordId] = ref.split('|');
          broken++;
          diffs.push({
            sourceRecordId,
            targetRecordId,
            field,
            sourceValue: null,
            targetValue: `${logicalName}(${id})`,
            differenceType: 'BROKEN_REFERENCE',
            outcome: 'FAIL',
          });
        }
      }
    }
    base.brokenReferences = broken;
    checks.push(
      broken === 0
        ? { check: 'REFERENCES', outcome: 'PASS', message: 'All lookup references resolve in the target' }
        : { check: 'REFERENCES', outcome: 'FAIL', message: `${broken} lookup value(s) reference records that do not exist in the target` },
    );

    return this.saveEntity(vr.id, { ...base, outcome: worst(checks.map((c) => c.outcome)) }, diffs);
  }

  private async fetchByIds(conn: DataverseConnection, table: TableMetadata, ids: string[], columns: string[]) {
    const out = new Map<string, DvRecord>();
    for (let i = 0; i < ids.length; i += 200) {
      for (const r of await conn.retrieveByIds(table, ids.slice(i, i + 200), columns)) out.set(r.id.toLowerCase(), r);
    }
    return out;
  }

  private async saveEntity(validationRunId: string, result: ValidationEntityResultDto, diffs: PendingDiff[]) {
    await this.db.insert(validationEntityResults).values({
      validationRunId,
      logicalName: result.logicalName,
      displayName: result.displayName,
      outcome: result.outcome,
      sourceCount: result.sourceCount,
      targetCount: result.targetCount,
      migratedRecords: result.migratedRecords,
      checkedRecords: result.checkedRecords,
      matched: result.matched,
      missing: result.missing,
      different: result.different,
      brokenReferences: result.brokenReferences,
      checks: result.checks,
    });
    const capped = diffs.slice(0, MAX_DIFFERENCES_PER_TABLE);
    for (let i = 0; i < capped.length; i += 200) {
      await this.db.insert(validationDifferences).values(
        capped.slice(i, i + 200).map((d) => ({ validationRunId, logicalName: result.logicalName, ...d })),
      );
    }
    return result;
  }

  async get(ctx: Pick<RequestContext, 'organizationId'>, id: string): Promise<ValidationRunDto> {
    const src = alias(environments, 'src');
    const tgt = alias(environments, 'tgt');
    const [row] = await this.db
      .select({ vr: validationRuns, src, tgt, user: users.displayName })
      .from(validationRuns)
      .innerJoin(src, eq(src.id, validationRuns.sourceEnvironmentId))
      .innerJoin(tgt, eq(tgt.id, validationRuns.targetEnvironmentId))
      .leftJoin(users, eq(users.id, validationRuns.createdByUserId))
      .where(and(eq(validationRuns.id, id), eq(validationRuns.organizationId, ctx.organizationId)));
    if (!row) throw notFound('Validation run');
    const entities = await this.db
      .select()
      .from(validationEntityResults)
      .where(eq(validationEntityResults.validationRunId, id))
      .orderBy(asc(validationEntityResults.logicalName));
    return {
      id: row.vr.id,
      status: row.vr.status,
      outcome: row.vr.outcome,
      migrationRunId: row.vr.migrationRunId,
      sourceEnvironment: envRef(row.src),
      targetEnvironment: envRef(row.tgt),
      tables: row.vr.tables,
      summary: row.vr.summary ?? null,
      entities: entities.map((e) => ({
        logicalName: e.logicalName,
        displayName: e.displayName,
        outcome: e.outcome,
        sourceCount: e.sourceCount,
        targetCount: e.targetCount,
        migratedRecords: e.migratedRecords,
        checkedRecords: e.checkedRecords,
        matched: e.matched,
        missing: e.missing,
        different: e.different,
        brokenReferences: e.brokenReferences,
        checks: e.checks,
      })),
      errorMessage: row.vr.errorMessage,
      progressMessage: row.vr.progressMessage,
      createdAt: row.vr.createdAt.toISOString(),
      completedAt: row.vr.completedAt?.toISOString() ?? null,
      createdBy: row.user ?? null,
    };
  }

  async list(ctx: Pick<RequestContext, 'organizationId'>, limit = 50) {
    const src = alias(environments, 'src');
    const tgt = alias(environments, 'tgt');
    const rows = await this.db
      .select({ vr: validationRuns, src, tgt, user: users.displayName })
      .from(validationRuns)
      .innerJoin(src, eq(src.id, validationRuns.sourceEnvironmentId))
      .innerJoin(tgt, eq(tgt.id, validationRuns.targetEnvironmentId))
      .leftJoin(users, eq(users.id, validationRuns.createdByUserId))
      .where(eq(validationRuns.organizationId, ctx.organizationId))
      .orderBy(desc(validationRuns.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map((r) => ({
      id: r.vr.id,
      status: r.vr.status,
      outcome: r.vr.outcome,
      migrationRunId: r.vr.migrationRunId,
      sourceEnvironment: envRef(r.src),
      targetEnvironment: envRef(r.tgt),
      tableCount: r.vr.tables.length,
      summary: r.vr.summary ?? null,
      createdAt: r.vr.createdAt.toISOString(),
      completedAt: r.vr.completedAt?.toISOString() ?? null,
      createdBy: r.user ?? null,
    }));
  }

  async differences(
    ctx: RequestContext,
    id: string,
    filter: { entity?: string; type?: DifferenceType; outcome?: ValidationOutcome; limit: number; offset: number },
  ): Promise<{ items: ValidationDifferenceDto[]; total: number }> {
    await this.get(ctx, id);
    const conditions = [eq(validationDifferences.validationRunId, id)];
    if (filter.entity) conditions.push(eq(validationDifferences.logicalName, filter.entity));
    if (filter.type) conditions.push(eq(validationDifferences.differenceType, filter.type));
    if (filter.outcome) conditions.push(eq(validationDifferences.outcome, filter.outcome));
    const [total] = await this.db.select({ n: count() }).from(validationDifferences).where(and(...conditions));
    const rows = await this.db
      .select()
      .from(validationDifferences)
      .where(and(...conditions))
      .orderBy(asc(validationDifferences.logicalName), asc(validationDifferences.sourceRecordId), asc(validationDifferences.field))
      .limit(filter.limit)
      .offset(filter.offset);
    return {
      total: Number(total?.n ?? 0),
      items: rows.map((d) => ({
        id: d.id,
        entity: d.logicalName,
        sourceRecordId: d.sourceRecordId,
        targetRecordId: d.targetRecordId,
        field: d.field,
        sourceValue: d.sourceValue,
        targetValue: d.targetValue,
        differenceType: d.differenceType as DifferenceType,
        outcome: d.outcome,
      })),
    };
  }
}
