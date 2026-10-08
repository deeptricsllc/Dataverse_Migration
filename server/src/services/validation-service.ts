import { and, asc, count, desc, eq, gt, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import type {
  ChoiceMappingDto,
  DifferenceType,
  FieldTransformDto,
  RecordOutcome,
  TransformationRule,
  ValidationCheckDto,
  ValidationDifferenceDto,
  ValidationEntityResultDto,
  ValidationOutcome,
  ValidationRunDto,
  ValidationSummary,
  UncomparedColumn,
} from '../../../shared/domain';
import {
  LOOKUP_TYPES,
  isLookupValue,
  type AttributeMeta,
  type DvRecord,
  type FieldValue,
  type TableMetadata,
} from '../../../shared/metadata';
import { basisFor, describeUniqueness } from '../../../shared/uniqueness';
import type { AppDb } from '../db/client';
import {
  environments,
  migrationRecordMaps,
  migrationRuns,
  users,
  validationDifferences,
  validationEntityResults,
  principalMaps,
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
import { auditFlags, type PlanOptions } from '../../../shared/domain';
import {
  AGGREGATE_CAVEAT,
  canCompareExtremes,
  canSum,
  totalsEqual,
  type AggregateCheck,
  type AggregateKind,
} from '../../../shared/aggregates';
import {
  accountedFor,
  accountingFromCounts,
  EMPTY_ACCOUNTING,
  sumAccounting,
  writtenByRun,
} from '../../../shared/run-metrics';
import {
  combineCoverage,
  coverageOf,
  DEFAULT_VALIDATION_DEPTH,
  depthCap,
  describeClean,
  describeCoverage,
  fullCoverage,
  notVerified,
  weakestMode,
  withMode,
  type ValidationDepth,
} from '../../../shared/validation-coverage';
import type { RunPlanSnapshot } from './run-snapshot';
import { diffTableDeep } from './schema-diff';
import { transformField } from './transformation/engine';
import { compareValues, displayValue } from './values';
import { envRef } from './env-ref';

/**
 * Worst wins. `INCOMPLETE` above `WARNING` because not knowing is worse than knowing something minor;
 * `FAIL` above `INCOMPLETE` because a proven mismatch is the actionable headline and the unchecked area
 * stays visible on the check that recorded it. See `docs/VALIDATION_SEMANTICS.md`.
 */
const RANK: Record<ValidationOutcome, number> = { PASS: 0, WARNING: 1, INCOMPLETE: 2, FAIL: 3 };
const worst = (outcomes: ValidationOutcome[]): ValidationOutcome =>
  outcomes.reduce<ValidationOutcome>((w, o) => (RANK[o] > RANK[w] ? o : w), 'PASS');

/** Maximum records compared field-by-field per table (reported when sampling applies). */
/** Records compared in one round trip. Constant memory per batch, whatever the table holds. */
const COMPARISON_BATCH = 500;
const MAX_DIFFERENCES_PER_TABLE = 2000;
/** Distinct repeated values reported per table. The count of records is never capped. */
const MAX_DUPLICATE_GROUPS = 50;
/** Columns reconciled by total per table. Each one is two or three queries on both sides. */
const MAX_AGGREGATE_COLUMNS = 12;

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
  /**
   * The mappings as the run executed them, including their transformation pipeline. Validation
   * compares the TRANSFORMED source value against the target, because that is what the migration
   * wrote: a source of `" ACTIVE "` that was trimmed and value-mapped to `100000000` matches a
   * target of `100000000`, and comparing the raw value would report a false mismatch.
   */
  mappings: {
    sourceField: string;
    targetField: string;
    isLookup: boolean;
    transformations?: TransformationRule[] | null;
    transform?: FieldTransformDto | null;
    choiceMap?: ChoiceMappingDto | null;
  }[];
  /** Records to compare: source record, target record (if found) and how it was migrated. */
  pairs: {
    source: DvRecord;
    target: DvRecord | null;
    /** `UNMAPPED` is validation's own value for a comparison made without a migration run. */
    outcome: RecordOutcome | 'UNMAPPED';
  }[];
  /** Resolves a source lookup to the expected target id (null = unknown). */
  expectedLookup: (logicalName: string, sourceId: string) => string | null;
}

/**
 * Pure field-level comparison used by the validation engine. Values are normalized so that
 * formatting-only differences (line endings, trailing whitespace, GUID case, precision,
 * date formatting) do not register as mismatches.
 */
/**
 * Which kind of difference this is.
 *
 * Three outcomes with three different fixes, and they used to be one. A value that is simply gone
 * points at the source or a required column; a value cut short points at a column too narrow for
 * the data, which is the dangerous one because the record still looks right; anything else is a
 * mapping or transformation question.
 *
 * Truncation is only claimed when the evidence is unambiguous: the target holds a strict prefix of
 * what was expected, and its length is exactly the column's declared maximum. A shorter value that
 * merely happens to start the same way is a mismatch, not a truncation.
 */
export function classifyDifference(
  target: AttributeMeta,
  expected: FieldValue | null,
  actual: FieldValue | undefined,
): DifferenceType {
  const expectedEmpty = expected === null || expected === undefined || expected === '';
  const actualEmpty = actual === null || actual === undefined || actual === '';
  if (!expectedEmpty && actualEmpty) return 'VALUE_LOST';
  if (
    typeof expected === 'string' &&
    typeof actual === 'string' &&
    target.maxLength != null &&
    actual.length === target.maxLength &&
    expected.length > actual.length &&
    expected.startsWith(actual)
  ) {
    return 'VALUE_TRUNCATED';
  }
  return 'VALUE_MISMATCH';
}

export function compareRecords(input: EntityComparisonInput): {
  matched: number;
  missing: number;
  different: number;
  diffs: PendingDiff[];
  /** Columns the comparison declined to answer for, and why. Empty when everything was comparable. */
  uncompared: UncomparedColumn[];
} {
  const sAttrs = new Map(input.source.attributes.map((a) => [a.logicalName, a]));
  const tAttrs = new Map(input.target.attributes.map((a) => [a.logicalName, a]));
  const diffs: PendingDiff[] = [];
  /**
   * Columns the comparison could not answer for. Counted per column rather than per record, because
   * the limitation belongs to the column: "payload could not be compared on 40 records" is actionable,
   * and "40 records are suspect" is not.
   */
  const uncompared = new Map<string, { reason: string; records: number }>();
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
      // The same engine the migration used, with the same rules from the run snapshot.
      const converted = transformField({
        value: sv ?? null,
        source: sAttr,
        target: tAttr,
        rules: m.transformations,
        legacyTransform: m.transform,
        choiceMap: m.choiceMap,
        context: { record: pair.source, sourceAttributes: sAttrs },
      });
      const expectedValue = converted.ok ? converted.value : (sv ?? null);
      const comparison = compareValues(tAttr, expectedValue, tv);
      if (comparison.verdict === 'NOT_COMPARABLE') {
        /**
         * Neither equal nor different, and said so rather than guessed. The record is still compared
         * on every other column, so one unreadable JSON document does not discard what is known about
         * the rest of the record — and the column is named, with the reason, at entity level.
         */
        const seen = uncompared.get(m.targetField);
        if (seen) seen.records++;
        else uncompared.set(m.targetField, { reason: comparison.reason ?? 'not comparable', records: 1 });
        continue;
      }
      if (comparison.verdict === 'DIFFERENT') {
        recordDiffers = true;
        diffs.push({
          sourceRecordId: pair.source.id,
          targetRecordId: pair.target.id,
          field: m.targetField,
          // The transformed value is what should be in the target, so that is what is reported.
          sourceValue: converted.ok ? displayValue(tAttr, expectedValue) : displayValue(sAttr, sv),
          targetValue: displayValue(tAttr, tv),
          differenceType: preExisting
            ? 'PRE_EXISTING_DIFFERENCE'
            : classifyDifference(tAttr, expectedValue, tv),
          outcome: preExisting ? 'WARNING' : 'FAIL',
        });
      }
    }
    if (recordDiffers) different++;
    else matched++;
  }
  return {
    matched,
    missing,
    different,
    diffs,
    uncompared: [...uncompared.entries()].map(([field, v]) => ({
      field,
      reason: v.reason,
      records: v.records,
    })),
  };
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
    input: {
      migrationRunId?: string;
      sourceEnvironmentId?: string;
      targetEnvironmentId?: string;
      tables?: string[];
      /** How many records to compare per table. Defaults to STANDARD. */
      depth?: ValidationDepth;
    },
  ): Promise<ValidationRunDto> {
    let sourceId: string;
    let targetId: string;
    let tables: string[];
    let migrationRunId: string | null = null;
    if (input.migrationRunId) {
      const [run] = await this.db
        .select()
        .from(migrationRuns)
        .where(
          and(
            eq(migrationRuns.id, input.migrationRunId),
            eq(migrationRuns.organizationId, ctx.organizationId),
          ),
        );
      if (!run) throw notFound('Migration run');
      if (['QUEUED', 'RUNNING'].includes(run.status))
        throw badRequest('Wait for the migration run to finish before validating');
      sourceId = run.sourceEnvironmentId;
      targetId = run.targetEnvironmentId;
      tables = run.planSnapshot.entities.map((e) => e.logicalName);
      migrationRunId = run.id;
    } else {
      if (!input.sourceEnvironmentId || !input.targetEnvironmentId || !input.tables?.length) {
        throw badRequest('Provide a migration run, or source, target and tables');
      }
      if (input.sourceEnvironmentId === input.targetEnvironmentId)
        throw badRequest('Source and target must be different environments');
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
        depth: input.depth ?? DEFAULT_VALIDATION_DEPTH,
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
    const progress = (progressMessage: string) =>
      this.db.update(validationRuns).set({ progressMessage }).where(eq(validationRuns.id, validationRunId));
    await this.db
      .update(validationRuns)
      .set({ status: 'RUNNING', startedAt: new Date() })
      .where(eq(validationRuns.id, validationRunId));
    await this.db
      .delete(validationEntityResults)
      .where(eq(validationEntityResults.validationRunId, validationRunId));
    await this.db
      .delete(validationDifferences)
      .where(eq(validationDifferences.validationRunId, validationRunId));
    log.info({ tables: vr.tables }, 'Validation started');
    try {
      if (!vr.createdByUserId) throw new Error('Validation has no initiating user');
      const source = await this.environmentsSvc.getInOrganization(vr.organizationId, vr.sourceEnvironmentId);
      const target = await this.environmentsSvc.getInOrganization(vr.organizationId, vr.targetEnvironmentId);
      const sConn = await this.connections.connectorFor(source, vr.createdByUserId, { validationRunId });
      const tConn = await this.connections.connectorFor(target, vr.createdByUserId, { validationRunId });
      const [runRow] = vr.migrationRunId
        ? await this.db
            .select({ s: migrationRuns.planSnapshot, o: migrationRuns.options })
            .from(migrationRuns)
            .where(eq(migrationRuns.id, vr.migrationRunId))
        : [];
      const snapshot: RunPlanSnapshot | null = runRow?.s ?? null;
      const runOptions = runRow?.o ?? null;
      // Users/teams have different ids per environment: the principal map says which target
      // principal a source principal became.
      const principalRows = await this.db
        .select({
          logicalName: principalMaps.logicalName,
          sourceId: principalMaps.sourceId,
          targetId: principalMaps.targetId,
        })
        .from(principalMaps)
        .where(
          and(
            eq(principalMaps.sourceEnvironmentId, vr.sourceEnvironmentId),
            eq(principalMaps.targetEnvironmentId, vr.targetEnvironmentId),
            inArray(principalMaps.status, ['AUTO_MATCHED', 'MANUAL']),
          ),
        );
      const principalMap = new Map(
        principalRows.filter((r) => r.targetId).map((r) => [`${r.logicalName}:${r.sourceId}`, r.targetId!]),
      );

      await progress('Loading metadata');
      const targetCatalog = await this.metadata.getCatalog(target.id, tConn, true);
      const sourceMeta = await this.metadata.getTables(source.id, sConn, vr.tables, { refresh: true });
      // Source table -> target table, from the plan snapshot. Same name within one provider;
      // a mapped name across providers.
      const targetTableFor = new Map<string, string>(
        (snapshot?.entities ?? []).map((e) => [e.logicalName, e.targetLogicalName]),
      );
      const referenced = new Set(vr.tables.map((t) => targetTableFor.get(t) ?? t));
      for (const t of sourceMeta.values())
        for (const a of t.attributes)
          if (LOOKUP_TYPES.has(a.type))
            (a.targets ?? []).forEach((x) => referenced.add(targetTableFor.get(x) ?? x));
      const targetMeta = await this.metadata.getTables(
        target.id,
        tConn,
        [...referenced].filter((n) => targetCatalog.some((c) => c.logicalName === n)),
        { refresh: true },
      );
      this.metadata.invalidateCounts(source.id);
      this.metadata.invalidateCounts(target.id);

      // Null on runs that predate the setting, which are read as the default rather than as FULL.
      const depth: ValidationDepth = vr.depth ?? DEFAULT_VALIDATION_DEPTH;
      const results: ValidationEntityResultDto[] = [];
      for (const [i, table] of vr.tables.entries()) {
        await progress(`Validating ${table} (${i + 1}/${vr.tables.length})`);
        const result = await this.validateEntity({
          vr,
          table,
          source: sourceMeta.get(table),
          target: targetMeta.get(targetTableFor.get(table) ?? table),
          targetMeta,
          targetTableFor,
          snapshotEntity: snapshot?.entities.find((e) => e.logicalName === table) ?? null,
          runOptions,
          depth,
          principalMap,
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
        accounting: sumAccounting(results.map((r) => r.accounting ?? EMPTY_ACCOUNTING)),
        // The weakest claim any table can support, including the duplicate check, which can be
        // NOT VERIFIED on a table whose values all matched.
        // Counts come from the record coverage only — the duplicate scan examines the same records
        // and adding both would report twice as many as exist. Its mode still counts, because a
        // dimension nobody could check must not leave the report claiming full coverage.
        coverage: withMode(
          combineCoverage(results.map((r) => r.coverage ?? fullCoverage(0))),
          weakestMode([
            combineCoverage(results.map((r) => r.coverage ?? fullCoverage(0))).mode,
            ...results.map((r) => r.duplicateCoverage?.mode ?? 'FULL'),
          ]),
          results.find((r) => r.duplicateCoverage?.mode === 'NOT_VERIFIED')?.duplicateCoverage?.reason,
        ),
        depth,
        duplicateRecords: results.reduce(
          (n, r) => n + (r.duplicates ?? []).reduce((m, d) => m + d.occurrences, 0),
          0,
        ),
        businessUniquenessVerifiedTables: results.filter(
          (r) => r.uniqueness?.provesBusinessUniqueness === true,
        ).length,
        matchedRecords: results.reduce((n, r) => n + r.matched, 0),
        missingRecords: results.reduce((n, r) => n + r.missing, 0),
        failedInRunRecords: results.reduce((n, r) => n + r.failedInRun, 0),
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
        .set({
          status: 'FAILED',
          errorMessage: message.slice(0, 2000),
          completedAt: new Date(),
          progressMessage: 'Failed',
        })
        .where(eq(validationRuns.id, validationRunId));
      await this.audit.record({
        organizationId: vr.organizationId,
        userId: vr.createdByUserId,
        action: 'VALIDATION_FAILED',
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
    /** Source table -> target table, so lookups are compared against the right target table. */
    targetTableFor: ReadonlyMap<string, string>;
    snapshotEntity: RunPlanSnapshot['entities'][number] | null;
    runOptions: PlanOptions | null;
    /** How many records this validation may compare per table. */
    depth: ValidationDepth;
    principalMap: ReadonlyMap<string, string>;
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
      accounting: { ...EMPTY_ACCOUNTING },
      checkedRecords: 0,
      failedInRun: 0,
      unresolvedInRun: 0,
      coverage: null,
      duplicates: null,
      duplicateCoverage: null,
      uniqueness: null,
      uncomparedColumns: null,
      aggregates: null,
      matched: 0,
      missing: 0,
      different: 0,
      brokenReferences: 0,
      checks,
    };

    // 1. Schema
    if (!source || !target) {
      checks.push({
        check: 'SCHEMA',
        outcome: 'FAIL',
        message: `Table is missing in the ${!source ? 'source' : 'target'} environment`,
      });
      return this.saveEntity(vr.id, { ...base, outcome: 'FAIL' }, diffs);
    }
    const tableDiff = diffTableDeep(source, target);
    const breaking = tableDiff.columns.filter(
      (c) => c.status === 'INCOMPATIBLE' || c.differences.some((d) => d.breaking),
    );
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
          ? {
              check: 'ROW_COUNT',
              outcome: 'WARNING',
              message: `Target has ${tc.count - sc.count} more row(s) than source (${tc.count} vs ${sc.count})${approx}`,
            }
          : {
              check: 'ROW_COUNT',
              outcome: 'FAIL',
              message: `Target has ${sc.count - tc.count} fewer row(s) than source (${tc.count} vs ${sc.count})${approx}`,
            },
    );

    /**
     * What this run did with this table, counted by the database.
     *
     * This used to load every identity row for the table and count the array. A ten-million-record
     * table has ten million identity rows, so counting them that way needs ten million objects in
     * memory before the first comparison — and the count is the one number every screen shows, so
     * the cheapest report was the one that could not be produced at all at the size where somebody
     * would pay for it. Five numbers come back instead, whatever the table holds.
     */
    const mapScope = vr.migrationRunId
      ? and(eq(migrationRecordMaps.runId, vr.migrationRunId), eq(migrationRecordMaps.logicalName, table))!
      : null;
    const outcomeCounts = mapScope
      ? await this.db
          .select({ outcome: migrationRecordMaps.outcome, n: count() })
          .from(migrationRecordMaps)
          .where(mapScope)
          .groupBy(migrationRecordMaps.outcome)
      : [];
    const mappings =
      p.snapshotEntity?.mappings ??
      source.attributes
        .filter(
          (a) =>
            !a.attributeOf &&
            !a.isPrimaryId &&
            a.isValidForCreate &&
            target.attributes.some((t) => t.logicalName === a.logicalName && t.type === a.type),
        )
        .filter(
          (a) => !['ownerid', 'statecode', 'statuscode', 'createdon', 'modifiedon'].includes(a.logicalName),
        )
        .map((a) => ({
          sourceField: a.logicalName,
          targetField: a.logicalName,
          isLookup: LOOKUP_TYPES.has(a.type),
        }));

    // Ownership and audit columns are validated when the run was asked to preserve them.
    const auditEntity = p.snapshotEntity?.audit;
    const o = p.runOptions;
    const auditChecks: { sourceField: string; targetField: string; isLookup: boolean }[] = [];
    const bothHave = (name: string) =>
      source.attributes.some((a) => a.logicalName === name) &&
      target.attributes.some((a) => a.logicalName === name);
    const flags = o
      ? auditFlags(o.auditPolicy)
      : { owner: false, createdOn: false, createdBy: false, modifiedBy: false };
    if (flags.owner && auditEntity?.ownerField && bothHave('ownerid'))
      auditChecks.push({ sourceField: 'ownerid', targetField: 'ownerid', isLookup: true });
    if (flags.createdOn && auditEntity?.overriddenCreatedOnField && bothHave('createdon'))
      auditChecks.push({ sourceField: 'createdon', targetField: 'createdon', isLookup: false });
    if (flags.createdBy && bothHave('createdby'))
      auditChecks.push({ sourceField: 'createdby', targetField: 'createdby', isLookup: true });
    if (flags.modifiedBy && auditEntity?.touchField && bothHave('modifiedby'))
      auditChecks.push({ sourceField: 'modifiedby', targetField: 'modifiedby', isLookup: true });
    for (const check of auditChecks)
      if (!mappings.some((m) => m.targetField === check.targetField)) mappings.push(check);

    // What the run did, in the one shape the whole product reads. `verifiable` is a different
    // question from "what did this run write": a record the run skipped is in the target and worth
    // checking, but the run did not write it. Collapsing the two is what made the report claim 28
    // records were written by a run that created nothing.
    base.accounting = accountingFromCounts(outcomeCounts);
    const failedInRun = base.accounting.failed;
    const unresolvedInRun = base.accounting.unresolved;
    /**
     * Rows that can be compared at all.
     *
     * Not failed — a failed record has nothing in the target to compare against — and not unresolved
     * either: a record whose write outcome is unknown may or may not be there, and comparing it would
     * report "missing" for something that might be present, or "matched" for something whose presence
     * nobody can account for. Both are claims the evidence does not support, so the record is excluded
     * from the comparison and reported as what it is.
     */
    const verifiableScope = mapScope
      ? and(
          mapScope,
          ne(migrationRecordMaps.outcome, 'FAILED'),
          ne(migrationRecordMaps.outcome, 'UNRESOLVED'),
          isNotNull(migrationRecordMaps.targetId),
        )!
      : null;
    const [verifiableRow] = verifiableScope
      ? await this.db.select({ n: count() }).from(migrationRecordMaps).where(verifiableScope)
      : [];
    const verifiableCount = Number(verifiableRow?.n ?? 0);

    // How many records this validation was asked to compare. FULL has no cap, which is the only
    // setting that can report full coverage.
    const cap = depthCap(p.depth);
    const cmp = { matched: 0, missing: 0, different: 0 };
    /** Columns the comparison declined to answer for, merged across batches. */
    const uncompared = new Map<string, { reason: string; records: number }>();
    let examined = 0;
    // Every difference found, including the ones past the listing cap. The counts a reader adds up
    // must be the real ones; only the examples are limited.
    let totalDifferences = 0;
    /** Differences by kind, tallied as batches go by rather than counted from a kept list. */
    const byType = new Map<DifferenceType, number>();
    const countOf = (type: DifferenceType) => byType.get(type) ?? 0;
    let broken = 0;

    /**
     * One batch of records, compared and then let go.
     *
     * The whole table used to be read into memory, compared in one call, and the differences kept
     * whether or not they could be stored. FULL validation of a large table therefore held every
     * source record, every target record and every difference at once — three copies of a table
     * nobody has that much memory for. Batches of a few hundred cost the same per record and a
     * constant amount of memory, so the only thing that grows with the table is the time.
     */
    const comparePairs = async (pairs: EntityComparisonInput['pairs']) => {
      if (pairs.length === 0) return;
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
          for (const r of rows)
            if (!expected.has(`${logicalName}:${r.sourceId}`))
              expected.set(`${logicalName}:${r.sourceId}`, r.targetId!);
        }
        const unresolved = idList.filter((id) => !expected.has(`${logicalName}:${id}`));
        const tTable = p.targetMeta.get(p.targetTableFor.get(logicalName) ?? logicalName);
        if (unresolved.length && tTable) {
          const found = await p.tConn.retrieveByIds(tTable, unresolved, []);
          for (const f of found) expected.set(`${logicalName}:${f.id.toLowerCase()}`, f.id.toLowerCase());
        }
      }

      const batch = compareRecords({
        source,
        target,
        mappings,
        pairs,
        expectedLookup: (logicalName, id) =>
          p.principalMap.get(`${logicalName}:${id.toLowerCase()}`) ??
          expected.get(`${logicalName}:${id.toLowerCase()}`) ??
          null,
      });
      cmp.matched += batch.matched;
      cmp.missing += batch.missing;
      cmp.different += batch.different;
      for (const column of batch.uncompared) {
        const seen = uncompared.get(column.field);
        // The first reason is kept: the same column fails the same way, and a later record's wording
        // would only replace it with an equivalent one.
        if (seen) seen.records += column.records;
        else uncompared.set(column.field, { reason: column.reason, records: column.records });
      }
      examined += pairs.length;
      // The counts above are complete; only the listed examples are capped, and the report says so
      // when they are. Keeping every difference in memory to throw most of them away at the insert
      // was the other half of the same problem.
      for (const d of batch.diffs) {
        byType.set(d.differenceType, countOf(d.differenceType) + 1);
        if (diffs.length < MAX_DIFFERENCES_PER_TABLE) diffs.push(d);
      }
      totalDifferences += batch.diffs.length;

      // References: every lookup on a compared target record must point at a record that exists.
      // Resolved per batch, because the alternative is remembering every lookup value in the table
      // to ask about them all at the end.
      const refIds = new Map<string, Map<string, string[]>>();
      for (const pair of pairs) {
        if (!pair.target) continue;
        for (const m of mappings.filter((x) => x.isLookup)) {
          const v = pair.target.values[m.targetField];
          if (!isLookupValue(v)) continue;
          if (!refIds.has(v.logicalName)) refIds.set(v.logicalName, new Map());
          const byId = refIds.get(v.logicalName)!;
          byId.set(v.id.toLowerCase(), [
            ...(byId.get(v.id.toLowerCase()) ?? []),
            `${pair.target.id}|${m.targetField}|${pair.source.id}`,
          ]);
        }
      }
      for (const [logicalName, byId] of refIds) {
        const tTable = p.targetMeta.get(p.targetTableFor.get(logicalName) ?? logicalName);
        const ids = [...byId.keys()];
        const found = new Set<string>();
        if (tTable)
          (await p.tConn.retrieveByIds(tTable, ids, [])).forEach((r) => found.add(r.id.toLowerCase()));
        for (const id of ids.filter((x) => !found.has(x))) {
          for (const ref of byId.get(id)!) {
            const [targetRecordId, field, sourceRecordId] = ref.split('|');
            broken++;
            totalDifferences++;
            if (diffs.length < MAX_DIFFERENCES_PER_TABLE)
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
    };

    if (verifiableScope) {
      let cursor: string | null = null;
      for (;;) {
        const remaining = cap === null ? COMPARISON_BATCH : Math.min(COMPARISON_BATCH, cap - examined);
        if (remaining <= 0) break;
        const page = await this.db
          .select({
            sourceId: migrationRecordMaps.sourceId,
            targetId: migrationRecordMaps.targetId,
            outcome: migrationRecordMaps.outcome,
          })
          .from(migrationRecordMaps)
          .where(
            cursor === null
              ? verifiableScope
              : and(verifiableScope, gt(migrationRecordMaps.sourceId, cursor)),
          )
          .orderBy(asc(migrationRecordMaps.sourceId))
          .limit(remaining);
        if (page.length === 0) break;
        const [sourceRecords, targetRecords] = await Promise.all([
          this.fetchByIds(
            p.sConn,
            source,
            page.map((m) => m.sourceId),
            mappings.map((m) => m.sourceField),
          ),
          this.fetchByIds(
            p.tConn,
            target,
            page.map((m) => m.targetId!),
            mappings.map((m) => m.targetField),
          ),
        ]);
        await comparePairs(
          page
            .filter((m) => sourceRecords.has(m.sourceId))
            .map((m) => ({
              source: sourceRecords.get(m.sourceId)!,
              target: targetRecords.get(m.targetId!.toLowerCase()) ?? null,
              outcome: m.outcome,
            })),
        );
        cursor = page[page.length - 1]!.sourceId;
        if (page.length < remaining) break;
      }
    } else {
      // Without a run: compare records by identical primary id, a page at a time.
      let batch: DvRecord[] = [];
      const flush = async () => {
        if (batch.length === 0) return;
        const targetRecords = await this.fetchByIds(
          p.tConn,
          target,
          batch.map((r) => r.id),
          mappings.map((m) => m.targetField),
        );
        await comparePairs(
          batch.map((r) => ({
            source: r,
            target: targetRecords.get(r.id.toLowerCase()) ?? null,
            outcome: 'UNMAPPED' as const,
          })),
        );
        batch = [];
      };
      outer: for await (const page of p.sConn.queryRecords(
        source,
        mappings.map((m) => m.sourceField),
        { pageSize: COMPARISON_BATCH },
      )) {
        for (const record of page) {
          batch.push(record);
          if (batch.length >= COMPARISON_BATCH) await flush();
          if (cap !== null && examined + batch.length >= cap) break outer;
        }
      }
      await flush();
    }

    // Records the run itself reported as failed. Listed as examples up to the same cap, because a
    // thousand identical "failed to migrate" rows tell a reader nothing the count did not.
    if (mapScope && failedInRun > 0 && diffs.length < MAX_DIFFERENCES_PER_TABLE) {
      const failedExamples = await this.db
        .select({ sourceId: migrationRecordMaps.sourceId })
        .from(migrationRecordMaps)
        .where(and(mapScope, eq(migrationRecordMaps.outcome, 'FAILED'))!)
        .orderBy(asc(migrationRecordMaps.sourceId))
        .limit(MAX_DIFFERENCES_PER_TABLE - diffs.length);
      for (const f of failedExamples) {
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
      totalDifferences += failedInRun;
    }
    base.checkedRecords = examined;
    base.matched = cmp.matched;
    /**
     * Two different facts, kept apart.
     *
     * `missing` is validation's own finding: a record the run said it had dealt with, which is not
     * in the target. `failedInRun` is the run's finding, confirmed here: a record the run already
     * reported as failed, which is absent for a reason nobody needs validation to discover.
     *
     * They used to be added together, and the sum broke the arithmetic a reader does naturally.
     * A report could say 66 matched, 3 missing and 1 differing over 67 examined records — three
     * numbers each correct, adding to seventy, over sixty-seven. Found by reconciling a deployed
     * report by hand rather than by a test, which is also how the last one was found.
     */
    base.missing = cmp.missing;
    base.failedInRun = failedInRun;
    base.unresolvedInRun = unresolvedInRun;
    base.different = cmp.different;
    /**
     * Columns nobody can answer for.
     *
     * Reported as a WARNING rather than folded into `different`, because "we could not compare this"
     * and "this does not match" are different statements and only one of them is a finding about the
     * data. The records were still compared on every other column, which is why they are counted as
     * matched — the limit is on a column, and that is where the report puts it.
     */
    base.uncomparedColumns =
      uncompared.size > 0
        ? [...uncompared.entries()].map(([field, v]) => ({ field, reason: v.reason, records: v.records }))
        : null;
    if (base.uncomparedColumns) {
      const listed = base.uncomparedColumns
        .slice(0, 5)
        .map((c) => `${c.field} (${c.reason}; ${c.records} record(s))`)
        .join('; ');
      const more = base.uncomparedColumns.length > 5 ? ` and ${base.uncomparedColumns.length - 5} more` : '';
      checks.push({
        check: 'FIELD_VALUES',
        outcome: 'WARNING',
        message: `${base.uncomparedColumns.length} column(s) could not be compared: ${listed}${more}. Every other column on those records was compared normally.`,
      });
    }
    // Coverage is derived from the counts rather than written beside them, so a message cannot
    // claim more than the numbers underneath it support.
    base.coverage = coverageOf({
      eligible: vr.migrationRunId ? verifiableCount : (base.sourceCount ?? examined),
      examined,
      cap,
    });
    const sampleNote = base.coverage.mode === 'SAMPLED' ? ` ${describeCoverage(base.coverage)}` : '';
    if (vr.migrationRunId) {
      const written = writtenByRun(base.accounting);
      // Says which of those records the run put there and which were already present, because
      // "they are all in the target" means something different for each.
      const composition =
        written === accountedFor(base.accounting)
          ? ''
          : ` (${written} written by this run, ${base.accounting.unchanged + base.accounting.skipped} already in the target)`;
      /**
       * Two reasons a record is not in the target, and both of them fail this check.
       *
       * Separating the counts was right — a record the run already reported as failed was never
       * compared, so adding it to `missing` made the arithmetic wrong. Separating the *verdict*
       * would have been wrong: a migration that did not deliver three records has not passed,
       * whatever the reason, and a report that says "passed with warnings" over it is the kind of
       * green badge this product exists to argue against.
       */
      const absent = base.missing + base.failedInRun;
      /**
       * A validation cannot pass over a record whose fate nobody knows.
       *
       * However well the records it *could* compare match, completeness is not provable while the
       * outcome of a write is unknown: the target may hold a record this report does not account for, or
       * may be missing one it claims. That is a statement about the migration rather than about the
       * comparison, and it must not be qualified away — a reader who sees a passing verdict next to a
       * footnote will remember the verdict.
       */
      if (unresolvedInRun > 0) {
        checks.push({
          check: 'RECORD_EXISTENCE',
          /*
           * Incomplete rather than failed, now that the two can be told apart. Nothing here was shown to
           * disagree: these records were excluded from the comparison precisely because nobody can say
           * what happened to them. Calling it a failure claims a mismatch that was never found.
           */
          outcome: 'INCOMPLETE',
          message:
            `${unresolvedInRun} record(s) have an unknown write outcome, so this migration's completeness cannot be proven. ` +
            `Each one may or may not be in the target; the run lists them and they must be reconciled before any verdict here means anything.` +
            (absent > 0 ? ` A further ${absent} record(s) are known not to be in the target.` : ''),
        });
      }
      /**
       * A check that examined nothing cannot pass.
       *
       * `absent === 0` was enough for a PASS, and with nothing examined `missing` and `failedInRun` are
       * both zero — so a validation that compared no records at all reported
       * "PASS: Not verified — no records were examined. Every one of them is in the target." A
       * self-contradicting sentence with a green badge on it, which is the exact failure this product
       * exists to argue against.
       *
       * Found by validating a migration from an uploaded file against deployed QA, where the source
       * records could not be re-read and the comparison therefore had nothing to do.
       */
      const nothingExamined = base.coverage?.mode === 'NOT_VERIFIED' || base.checkedRecords === 0;
      if (unresolvedInRun === 0)
        checks.push(
          absent > 0
            ? {
                check: 'RECORD_EXISTENCE',
                outcome: 'FAIL',
                message:
                  `${absent} record(s) are not in the target` +
                  (base.failedInRun
                    ? ` — ${base.failedInRun} the run reported as failed` +
                      (base.missing ? `, ${base.missing} it did not` : '')
                    : '') +
                  `${sampleNote}`,
              }
            : nothingExamined
              ? {
                  check: 'RECORD_EXISTENCE',
                  /*
                   * Not verified, which is now its own outcome rather than a warning. The comment above
                   * describes this exact trap being caught once already — a green badge on a
                   * self-contradicting sentence — and `WARNING` left the headline reading
                   * *Passed with warnings* for a check that examined nothing.
                   */
                  outcome: 'INCOMPLETE',
                  message: `Not verified. ${base.coverage?.reason ?? 'No records were examined.'} Nothing here says whether this run's records are in the target.`,
                }
              : {
                  check: 'RECORD_EXISTENCE',
                  outcome: 'PASS',
                  message: `${describeCoverage(base.coverage, 'records this run accounted for')} Every one of them is in the target${composition}.`,
                },
        );
    } else {
      checks.push({
        check: 'RECORD_EXISTENCE',
        outcome: cmp.missing === 0 ? 'PASS' : 'FAIL',
        message: `${examined - cmp.missing} of ${examined} source record(s) found in target by identifier${cmp.missing ? `; ${cmp.missing} missing` : ''}`,
      });
    }
    const lost = countOf('VALUE_LOST');
    const truncated = countOf('VALUE_TRUNCATED');
    const valueFails = countOf('VALUE_MISMATCH') + countOf('LOOKUP_MISMATCH') + lost + truncated;
    const preExisting = countOf('PRE_EXISTING_DIFFERENCE');
    // Named separately because they are different problems: a value gone, a value cut off by a
    // column too narrow for it, and a value that is simply wrong each send somebody somewhere else.
    const breakdown = [
      lost > 0 ? `${lost} value(s) did not arrive` : null,
      truncated > 0 ? `${truncated} value(s) were cut off by a narrower target column` : null,
    ]
      .filter(Boolean)
      .join('; ');
    checks.push(
      valueFails > 0
        ? {
            check: 'FIELD_VALUES',
            outcome: 'FAIL',
            message: `${valueFails} field mismatch(es) across ${cmp.different} record(s)${breakdown ? ` — ${breakdown}` : ''}`,
          }
        : preExisting > 0
          ? {
              check: 'FIELD_VALUES',
              outcome: 'WARNING',
              message: `${preExisting} difference(s) on pre-existing target records that were skipped`,
            }
          : base.coverage?.mode === 'NOT_VERIFIED' || base.checkedRecords === 0
            ? {
                check: 'FIELD_VALUES',
                /*
                 * Nothing was compared, so there is nothing to pass — and nothing to warn about either.
                 * This was `WARNING`, which the report prints as *Passed with warnings*, so a validation
                 * that compared no column on any record put the word passed in its headline.
                 */
                outcome: 'INCOMPLETE',
                message: `Not verified. ${base.coverage?.reason ?? 'No records were examined.'} No column was compared on any record.`,
              }
            : {
                check: 'FIELD_VALUES',
                outcome: 'PASS',
                message: `${describeClean(base.coverage, `records on ${mappings.length} mapped column(s)`)}`,
              },
    );

    // 5. References were resolved batch by batch, as the records were compared.
    base.brokenReferences = broken;
    checks.push(
      broken === 0
        ? { check: 'REFERENCES', outcome: 'PASS', message: 'All lookup references resolve in the target' }
        : {
            check: 'REFERENCES',
            outcome: 'FAIL',
            message: `${broken} lookup value(s) reference records that do not exist in the target`,
          },
    );

    await this.scanDuplicates(p, target, base, checks, mapScope);
    await this.reconcileAggregates(p, source, target, base, checks, mappings);

    return this.saveEntity(
      vr.id,
      { ...base, outcome: worst(checks.map((c) => c.outcome)) },
      diffs,
      totalDifferences,
    );
  }

  private async fetchByIds(
    conn: DataverseConnection,
    table: TableMetadata,
    ids: string[],
    columns: string[],
  ) {
    const out = new Map<string, DvRecord>();
    for (let i = 0; i < ids.length; i += 200) {
      for (const r of await conn.retrieveByIds(table, ids.slice(i, i + 200), columns))
        out.set(r.id.toLowerCase(), r);
    }
    return out;
  }

  /**
   * Compares totals across the two sides, where the comparison means something.
   *
   * Supplementary evidence, never a substitute: two tables can agree on every total and differ in
   * every row. What it buys is reach — a hundred million rows can be summed when they cannot be
   * compared one at a time — so it is offered precisely where record-level validation runs out.
   *
   * Scope is where this check goes wrong, and the rule here is strict about it. A total over the
   * whole target table answers a different question from "did this run move the data correctly"
   * whenever the target holds anything this run did not write. There is no cheap way to restrict a
   * SUM to one run's records — the identity map holds the ids, and an IN list of ten million of
   * them is not a query — so rather than compare the wrong two numbers, this reports NOT VERIFIED
   * and says why. A pilot migrating into an empty target gets the evidence; a top-up migration is
   * told plainly that it cannot have it this way.
   */
  private async reconcileAggregates(
    p: { sConn: DataverseConnection; tConn: DataverseConnection },
    source: TableMetadata,
    target: TableMetadata,
    base: ValidationEntityResultDto,
    checks: ValidationCheckDto[],
    mappings: { sourceField: string; targetField: string }[],
  ): Promise<void> {
    const sourceAggregate = p.sConn.aggregate?.bind(p.sConn);
    const targetAggregate = p.tConn.aggregate?.bind(p.tConn);
    const results: AggregateCheck[] = [];
    const note = (check: AggregateCheck) => results.push(check);

    if (!sourceAggregate || !targetAggregate) {
      note({
        kind: 'COUNT',
        entity: base.logicalName,
        column: null,
        sourceValue: null,
        targetValue: null,
        outcome: 'NOT_VERIFIED',
        scope: 'Not attempted.',
        reason: `${!sourceAggregate ? p.sConn.provider : p.tConn.provider} cannot compute a total without reading the whole table.`,
      });
      base.aggregates = results;
      return;
    }

    const written = base.accounting ? writtenByRun(base.accounting) : 0;
    const targetRows = base.targetCount ?? null;
    // The one scope in which a target total answers the question asked of it.
    const ownsWholeTarget = targetRows !== null && targetRows === written && written > 0;
    const scope = ownsWholeTarget
      ? `All ${written} record(s) in the target were written by this run.`
      : `The target holds ${targetRows ?? 'an unknown number of'} record(s); this run wrote ${written}.`;

    note({
      kind: 'COUNT',
      entity: base.logicalName,
      column: null,
      sourceValue: base.sourceCount === null ? null : String(base.sourceCount),
      targetValue: targetRows === null ? null : String(targetRows),
      outcome: ownsWholeTarget ? (base.sourceCount === targetRows ? 'PASS' : 'FAIL') : 'NOT_VERIFIED',
      scope,
      reason: ownsWholeTarget
        ? base.sourceCount === targetRows
          ? 'The target holds as many records as the source.'
          : 'The target does not hold as many records as the source.'
        : 'Counts cannot be compared while the target holds records this run did not write.',
    });

    if (!ownsWholeTarget) {
      base.aggregates = results;
      return;
    }

    // Only columns this run actually mapped, and only the ones whose totals mean the same thing on
    // both sides. Comparing everything the two schemas happen to share produced guaranteed
    // failures: `createdon` and `modifiedon` are written by the target platform at insert time, so
    // their extremes *must* differ, and a report that fails on them trains people to ignore it.
    const columns = mappings.flatMap((m) => {
      const attribute = source.attributes.find((a) => a.logicalName === m.sourceField);
      const twin = target.attributes.find((t) => t.logicalName === m.targetField);
      if (!attribute || !twin || attribute.isPrimaryId) return [];
      if (!canSum(attribute) && !canCompareExtremes(attribute)) return [];
      return [{ attribute, target: m.targetField }];
    });
    for (const { attribute, target: targetField } of columns.slice(0, MAX_AGGREGATE_COLUMNS)) {
      const kinds: AggregateKind[] = [
        ...(canSum(attribute) ? (['SUM'] as const) : []),
        ...(canCompareExtremes(attribute) ? (['MIN', 'MAX'] as const) : []),
      ];
      const temporal = attribute.type === 'DateTime';
      // A Money or Decimal column declares how exact it is; totals are compared at that
      // exactness rather than at whatever precision each side accumulated on the way to the sum.
      // `sql.scale` for a real column, `precision` for a Dataverse money or decimal attribute,
      // which is the same fact under a different name.
      const scale = temporal ? null : (attribute.sql?.scale ?? attribute.precision ?? null);
      for (const kind of kinds) {
        try {
          const [left, right] = await Promise.all([
            sourceAggregate(source, attribute.logicalName, kind),
            targetAggregate(target, targetField, kind),
          ]);
          if (left === null && right === null) {
            // Nothing to total. Reporting this as a pass would offer two absences as evidence.
            note({
              kind,
              entity: base.logicalName,
              column: attribute.logicalName,
              sourceValue: null,
              targetValue: null,
              outcome: 'NOT_VERIFIED',
              scope,
              reason: 'Neither side holds any value in this column, so there is nothing to total.',
            });
            continue;
          }
          // Compared as exact decimals rather than through a float, so a money column with more
          // digits than a double can hold is still compared truthfully; timestamps are compared as
          // instants, so two engines rendering one moment differently is not a failure.
          const same = totalsEqual(left, right, { temporal, scale });
          // Said in the result, not only in the code: somebody comparing the two printed figures
          // digit by digit needs to know the comparison was made at the column's own exactness.
          const atScale =
            !same || scale === null || kind !== 'SUM'
              ? ''
              : ` Compared to ${scale} decimal place(s), which is all this column holds.`;
          note({
            kind,
            entity: base.logicalName,
            column: attribute.logicalName,
            sourceValue: left,
            targetValue: right,
            outcome: same ? 'PASS' : 'FAIL',
            scope,
            reason:
              (same ? 'The two sides report the same value.' : 'The two sides report different values.') +
              atScale,
          });
        } catch (err) {
          note({
            kind,
            entity: base.logicalName,
            column: attribute.logicalName,
            sourceValue: null,
            targetValue: null,
            outcome: 'NOT_VERIFIED',
            scope,
            reason: errorMessage(err).slice(0, 200),
          });
        }
      }
    }
    base.aggregates = results;
    const failed = results.filter((r) => r.outcome === 'FAIL');
    const verified = results.filter((r) => r.outcome !== 'NOT_VERIFIED');
    // Only when something was actually compared. A table whose totals could not be reconciled says
    // so in the aggregate panel, with its scope and reason, rather than through a warning on the
    // entity: "we could not compare these two numbers" is not a finding about the migration, and a
    // top-up run would otherwise never show a clean verdict again.
    if (verified.length > 0) {
      checks.push({
        check: 'AGGREGATES',
        outcome: failed.length > 0 ? 'FAIL' : 'PASS',
        message:
          (failed.length > 0
            ? `${failed.length} of ${verified.length} total(s) disagree between the two sides: ${failed
                .map((f) => `${f.kind}${f.column ? `(${f.column})` : ''}`)
                .join(', ')}.`
            : `${verified.length} total(s) agree between the two sides.`) + ` ${AGGREGATE_CAVEAT}`,
      });
    }
  }

  /**
   * Looks for key values that occur more than once in the target.
   *
   * Uniqueness was the one validation dimension the platform had no answer for: a migration can
   * duplicate every record it writes and still report that every value matches, because every
   * source record would find a target record holding the right values — just not only one of them.
   *
   * The counting happens in the system that holds the data, through an optional connector method.
   * A connector that cannot group reliably leaves it undefined and this reports NOT VERIFIED,
   * which is the honest answer and deliberately not PASS.
   */
  private async scanDuplicates(
    p: { snapshotEntity: RunPlanSnapshot['entities'][number] | null; tConn: DataverseConnection },
    target: TableMetadata,
    base: ValidationEntityResultDto,
    checks: ValidationCheckDto[],
    /** The identity rows for this run and table, as a predicate rather than as rows. */
    mapScope: SQL | null,
  ): Promise<void> {
    /**
     * What was supposed to be unique: the key the plan matched records on, or the table's own primary
     * id when nothing else was configured. Inventing a uniqueness expectation the customer never
     * stated would produce findings about data that was always allowed to repeat.
     *
     * The fallback is the important case. A scan of the target's own primary key finds nothing,
     * because the target refuses a repeat of it by itself — so reporting that as "no duplicates"
     * restates the platform's guarantee and says nothing about the data. The basis is recorded
     * alongside the finding so the report can tell the two apart.
     */
    const snapshot = p.snapshotEntity;
    const configured = basisFor({
      matchStrategy: snapshot?.matchStrategy,
      businessKeyFields: snapshot?.businessKeyFields ?? [],
      alternateKeyColumns:
        snapshot?.matchStrategy === 'ALTERNATE_KEY' && snapshot.alternateKey
          ? (target.keys.find((k) => k.logicalName === snapshot.alternateKey)?.attributes ?? [])
          : [],
    });
    const basis = configured?.basis ?? 'PRIMARY_KEY';
    const columns = configured?.columns ?? [target.primaryIdAttribute];
    /** Records the not-verified case once, so no branch can forget to say which it was. */
    const unverified = (examined: number, reason: string, outcome: ValidationOutcome = 'WARNING') => {
      base.duplicateCoverage = notVerified(examined, reason);
      base.uniqueness = describeUniqueness('NOT_VERIFIED', columns.filter(Boolean), { reason });
      checks.push({
        check: 'UNIQUENESS',
        outcome,
        message: `Duplicate keys: not verified. ${reason}`,
      });
    };

    if (columns.length === 0 || !columns[0]) {
      unverified(0, 'No key was configured for this table, and it has no primary id to fall back to.');
      return;
    }

    const scan = p.tConn.findDuplicateKeys?.bind(p.tConn);
    if (!scan) {
      unverified(
        base.targetCount ?? 0,
        `${p.tConn.provider} cannot count repeated values without reading the whole table, so this check did not run.`,
      );
      return;
    }

    let groups;
    try {
      groups = await scan(target, columns, { maxGroups: MAX_DUPLICATE_GROUPS, idsPerGroup: 5 });
    } catch (err) {
      unverified(base.targetCount ?? 0, errorMessage(err).slice(0, 200));
      return;
    }

    /**
     * Whether this run is responsible. Only answerable when every record in the group is in hand:
     * with a partial sample, the records this run wrote might be the ones not sampled.
     *
     * Asked about the sample rather than about the table. There are at most fifty groups of five
     * identifiers here, and looking those up is one indexed query — where loading the run's whole
     * identity map to build the same answer was the largest allocation in a validation.
     */
    const sampleIds = [...new Set(groups.flatMap((g) => g.sampleIds.map((id) => id.toLowerCase())))];
    const writtenHere = new Set<string>();
    if (mapScope && sampleIds.length > 0) {
      for (let i = 0; i < sampleIds.length; i += 500) {
        const rows = await this.db
          .select({ targetId: migrationRecordMaps.targetId })
          .from(migrationRecordMaps)
          .where(
            and(
              mapScope,
              inArray(migrationRecordMaps.outcome, ['CREATED', 'UPDATED']),
              inArray(sql`lower(${migrationRecordMaps.targetId})`, sampleIds.slice(i, i + 500)),
            ),
          );
        for (const r of rows) if (r.targetId) writtenHere.add(r.targetId.toLowerCase());
      }
    }
    base.duplicates = groups.map((g) => {
      const complete = g.count <= g.sampleIds.length;
      const mine = g.sampleIds.filter((id) => writtenHere.has(id.toLowerCase())).length;
      return {
        columns,
        value: Object.values(g.values)
          .map((v) => (v === null || v === undefined ? '(empty)' : String(v)))
          .join(' · '),
        occurrences: g.count,
        sampleIds: g.sampleIds,
        writtenByThisRun: complete ? mine : null,
        // One record this run wrote, sharing a key with one that was already there, is a collision
        // this run introduced. Zero means it was already like that.
        attributable: complete ? mine > 0 : null,
      };
    });
    const uniqueness = describeUniqueness(basis, columns);
    base.uniqueness = uniqueness;
    base.duplicateCoverage = fullCoverage(
      base.targetCount ?? 0,
      `Counted by ${p.tConn.provider}, grouping on ${columns.join(' + ')}.`,
    );

    const total = base.duplicates.reduce((n, d) => n + d.occurrences, 0);
    if (base.duplicates.length === 0) {
      /**
       * Nothing repeated. Whether that is worth anything depends entirely on what was grouped on, so
       * the two cases get different sentences: one reports a result, the other reports that the
       * question was not really asked.
       */
      checks.push({
        check: 'UNIQUENESS',
        outcome: 'PASS',
        message: uniqueness.provesBusinessUniqueness
          ? `No repeated values of ${columns.join(' + ')} in the target. ${uniqueness.proves}`
          : uniqueness.proves,
      });
      return;
    }
    const ours = base.duplicates.some((d) => d.attributable === true);
    const capped = base.duplicates.length >= MAX_DUPLICATE_GROUPS ? ` (first ${MAX_DUPLICATE_GROUPS})` : '';
    checks.push({
      check: 'UNIQUENESS',
      outcome: ours ? 'FAIL' : 'WARNING',
      message: ours
        ? `${base.duplicates.length} value(s) of ${columns.join(' + ')} are repeated across ${total} record(s)${capped}, and this run wrote at least one record in a repeated group.`
        : `${base.duplicates.length} value(s) of ${columns.join(' + ')} are repeated across ${total} record(s)${capped}. None of them were written by this run.`,
    });
  }

  private async saveEntity(
    validationRunId: string,
    result: ValidationEntityResultDto,
    diffs: PendingDiff[],
    /**
     * Every difference found, which is not the same as every difference in hand.
     *
     * The listing is capped before it reaches memory now, so the array no longer knows how many
     * there were. Inferring the total from the array would have quietly turned "2,000 of 40,000"
     * into "2,000", which is the one number in this message that matters.
     */
    totalDifferences = diffs.length,
  ) {
    await this.db.insert(validationEntityResults).values({
      validationRunId,
      logicalName: result.logicalName,
      displayName: result.displayName,
      outcome: result.outcome,
      sourceCount: result.sourceCount,
      targetCount: result.targetCount,
      recordAccounting: result.accounting,
      coverage: result.coverage,
      duplicates: result.duplicates,
      duplicateCoverage: result.duplicateCoverage,
      uniqueness: result.uniqueness,
      uncomparedColumns: result.uncomparedColumns,
      aggregates: result.aggregates,
      checkedRecords: result.checkedRecords,
      failedInRun: result.failedInRun,
      unresolvedInRun: result.unresolvedInRun,
      matched: result.matched,
      missing: result.missing,
      different: result.different,
      brokenReferences: result.brokenReferences,
      checks: result.checks,
    });
    // The stored list is capped, and a capped list that says nothing about it invites somebody to
    // conclude they have seen every difference. The check that reports this table carries the note, so
    // it travels with the result rather than living only in a comment here.
    const capped = diffs.slice(0, MAX_DIFFERENCES_PER_TABLE);
    if (totalDifferences > capped.length) {
      result.checks.push({
        check: 'FIELD_VALUES',
        outcome: 'WARNING',
        message: `Showing ${capped.length.toLocaleString()} of ${totalDifferences.toLocaleString()} differences. The counts are complete; the listed differences are the first ${MAX_DIFFERENCES_PER_TABLE.toLocaleString()}.`,
      });
    }
    for (let i = 0; i < capped.length; i += 200) {
      await this.db
        .insert(validationDifferences)
        .values(
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
      depth: row.vr.depth ?? DEFAULT_VALIDATION_DEPTH,
      summary: row.vr.summary ?? null,
      entities: entities.map((e) => ({
        logicalName: e.logicalName,
        displayName: e.displayName,
        outcome: e.outcome,
        sourceCount: e.sourceCount,
        targetCount: e.targetCount,
        // Null for a report written before the breakdown was recorded. The old `migratedRecords`
        // column is deliberately not read back: it answered a different question than it claimed.
        accounting: e.recordAccounting ?? null,
        coverage: e.coverage ?? null,
        duplicates: e.duplicates ?? null,
        duplicateCoverage: e.duplicateCoverage ?? null,
        uniqueness: e.uniqueness ?? null,
        uncomparedColumns: e.uncomparedColumns ?? null,
        aggregates: e.aggregates ?? null,
        checkedRecords: e.checkedRecords,
        failedInRun: e.failedInRun,
        unresolvedInRun: e.unresolvedInRun ?? 0,
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

  /**
   * The same differences, as pages, for an export that must not be capped.
   *
   * Keyed on the row id rather than on an offset: a validation of a large table can hold a lot of
   * differences, and `OFFSET` makes the database count and discard everything before the page.
   */
  async *differencePages(
    ctx: RequestContext,
    id: string,
    filter: { entity?: string; type?: DifferenceType; outcome?: ValidationOutcome; pageSize?: number } = {},
  ): AsyncGenerator<ValidationDifferenceDto[]> {
    await this.get(ctx, id);
    const size = Math.max(1, Math.min(filter.pageSize ?? 1000, 5000));
    const conditions = [eq(validationDifferences.validationRunId, id)];
    if (filter.entity) conditions.push(eq(validationDifferences.logicalName, filter.entity));
    if (filter.type) conditions.push(eq(validationDifferences.differenceType, filter.type));
    if (filter.outcome) conditions.push(eq(validationDifferences.outcome, filter.outcome));
    const scope = and(...conditions)!;
    type Row = typeof validationDifferences.$inferSelect;
    let cursor: string | null = null;
    for (;;) {
      const rows: Row[] = await this.db
        .select()
        .from(validationDifferences)
        .where(cursor === null ? scope : and(scope, gt(validationDifferences.id, cursor)))
        .orderBy(asc(validationDifferences.id))
        .limit(size);
      if (rows.length === 0) return;
      yield rows.map((d) => ({
        id: d.id,
        entity: d.logicalName,
        sourceRecordId: d.sourceRecordId,
        targetRecordId: d.targetRecordId,
        field: d.field,
        sourceValue: d.sourceValue,
        targetValue: d.targetValue,
        differenceType: d.differenceType as DifferenceType,
        outcome: d.outcome,
      }));
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < size) return;
    }
  }

  async differences(
    ctx: RequestContext,
    id: string,
    filter: {
      entity?: string;
      type?: DifferenceType;
      outcome?: ValidationOutcome;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: ValidationDifferenceDto[]; total: number }> {
    await this.get(ctx, id);
    const conditions = [eq(validationDifferences.validationRunId, id)];
    if (filter.entity) conditions.push(eq(validationDifferences.logicalName, filter.entity));
    if (filter.type) conditions.push(eq(validationDifferences.differenceType, filter.type));
    if (filter.outcome) conditions.push(eq(validationDifferences.outcome, filter.outcome));
    const [total] = await this.db
      .select({ n: count() })
      .from(validationDifferences)
      .where(and(...conditions));
    const rows = await this.db
      .select()
      .from(validationDifferences)
      .where(and(...conditions))
      .orderBy(
        asc(validationDifferences.logicalName),
        asc(validationDifferences.sourceRecordId),
        asc(validationDifferences.field),
      )
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
