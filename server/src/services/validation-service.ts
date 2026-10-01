import { and, asc, count, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import type {
  ChoiceMappingDto,
  DifferenceType,
  FieldTransformDto,
  TransformationRule,
  ValidationCheckDto,
  ValidationDifferenceDto,
  ValidationEntityResultDto,
  ValidationOutcome,
  ValidationRunDto,
  ValidationSummary,
} from '../../../shared/domain';
import {
  LOOKUP_TYPES,
  isLookupValue,
  type AttributeMeta,
  type DvRecord,
  type FieldValue,
  type TableMetadata,
} from '../../../shared/metadata';
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
  accountedFor,
  countOutcomes,
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
import { displayValue, valuesEqual } from './values';
import { envRef } from './env-ref';

const RANK: Record<ValidationOutcome, number> = { PASS: 0, WARNING: 1, FAIL: 2 };
const worst = (outcomes: ValidationOutcome[]): ValidationOutcome =>
  outcomes.reduce<ValidationOutcome>((w, o) => (RANK[o] > RANK[w] ? o : w), 'PASS');

/** Maximum records compared field-by-field per table (reported when sampling applies). */
const MAX_DIFFERENCES_PER_TABLE = 2000;
/** Distinct repeated values reported per table. The count of records is never capped. */
const MAX_DUPLICATE_GROUPS = 50;

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
    outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED' | 'FAILED' | 'UNMAPPED';
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
} {
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
      if (!valuesEqual(tAttr, expectedValue, tv)) {
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
      coverage: null,
      duplicates: null,
      duplicateCoverage: null,
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

    // Identity map for this migration run (or ID-based matching without one).
    const maps = vr.migrationRunId
      ? await this.db
          .select()
          .from(migrationRecordMaps)
          .where(
            and(eq(migrationRecordMaps.runId, vr.migrationRunId), eq(migrationRecordMaps.logicalName, table)),
          )
          .orderBy(asc(migrationRecordMaps.sourceId))
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

    let pairs: EntityComparisonInput['pairs'];
    const failedMaps = maps.filter((m) => m.outcome === 'FAILED');
    // What the run did, straight from its own record outcomes, in the one shape the whole product
    // reads. `verifiable` is a different question from "what did this run write": a record the run
    // skipped is in the target and worth checking, but the run did not write it. Collapsing the two
    // is what made the report claim 28 records were written by a run that created nothing.
    base.accounting = countOutcomes(maps.map((m) => m.outcome));
    const verifiable = maps.filter((m) => m.outcome !== 'FAILED' && m.targetId);

    // How many records this validation was asked to compare. FULL has no cap, which is the only
    // setting that can report full coverage.
    const cap = depthCap(p.depth);
    const sampled = cap === null ? verifiable : verifiable.slice(0, cap);
    if (vr.migrationRunId) {
      const sourceRecords = await this.fetchByIds(
        p.sConn,
        source,
        sampled.map((m) => m.sourceId),
        mappings.map((m) => m.sourceField),
      );
      const targetRecords = await this.fetchByIds(
        p.tConn,
        target,
        sampled.map((m) => m.targetId!),
        mappings.map((m) => m.targetField),
      );
      pairs = sampled
        .filter((m) => sourceRecords.has(m.sourceId))
        .map((m) => ({
          source: sourceRecords.get(m.sourceId)!,
          target: targetRecords.get(m.targetId!.toLowerCase()) ?? null,
          outcome: m.outcome,
        }));
    } else {
      // Without a run: compare records by identical primary id (sample).
      const sample: DvRecord[] = [];
      for await (const page of p.sConn.queryRecords(
        source,
        mappings.map((m) => m.sourceField),
        { pageSize: 500 },
      )) {
        sample.push(...page);
        if (cap !== null && sample.length >= cap) break;
      }
      const targetRecords = await this.fetchByIds(
        p.tConn,
        target,
        sample.map((r) => r.id),
        mappings.map((m) => m.targetField),
      );
      pairs = sample.map((r) => ({
        source: r,
        target: targetRecords.get(r.id.toLowerCase()) ?? null,
        outcome: 'UNMAPPED' as const,
      }));
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

    // 3 + 4. Existence and field values
    const cmp = compareRecords({
      source,
      target,
      mappings,
      pairs,
      expectedLookup: (logicalName, id) =>
        p.principalMap.get(`${logicalName}:${id.toLowerCase()}`) ??
        expected.get(`${logicalName}:${id.toLowerCase()}`) ??
        null,
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
    base.failedInRun = failedMaps.length;
    base.different = cmp.different;
    // Coverage is derived from the counts rather than written beside them, so a message cannot
    // claim more than the numbers underneath it support.
    base.coverage = coverageOf({
      eligible: vr.migrationRunId ? verifiable.length : (base.sourceCount ?? pairs.length),
      examined: pairs.length,
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
      checks.push(
        absent === 0
          ? {
              check: 'RECORD_EXISTENCE',
              outcome: 'PASS',
              message: `${describeCoverage(base.coverage, 'records this run accounted for')} Every one of them is in the target${composition}.`,
            }
          : {
              check: 'RECORD_EXISTENCE',
              outcome: 'FAIL',
              message:
                `${absent} record(s) are not in the target` +
                (base.failedInRun
                  ? ` — ${base.failedInRun} the run reported as failed` +
                    (base.missing ? `, ${base.missing} it did not` : '')
                  : '') +
                `${sampleNote}`,
            },
      );
    } else {
      checks.push({
        check: 'RECORD_EXISTENCE',
        outcome: cmp.missing === 0 ? 'PASS' : 'FAIL',
        message: `${pairs.length - cmp.missing} of ${pairs.length} source record(s) found in target by identifier${cmp.missing ? `; ${cmp.missing} missing` : ''}`,
      });
    }
    const countOf = (type: DifferenceType) => cmp.diffs.filter((d) => d.differenceType === type).length;
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
          : {
              check: 'FIELD_VALUES',
              outcome: 'PASS',
              message: `${describeClean(base.coverage, `records on ${mappings.length} mapped column(s)`)}`,
            },
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
        byId.set(v.id.toLowerCase(), [
          ...(byId.get(v.id.toLowerCase()) ?? []),
          `${pair.target.id}|${m.targetField}|${pair.source.id}`,
        ]);
      }
    }
    let broken = 0;
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
        : {
            check: 'REFERENCES',
            outcome: 'FAIL',
            message: `${broken} lookup value(s) reference records that do not exist in the target`,
          },
    );

    await this.scanDuplicates(p, target, base, checks, maps);

    return this.saveEntity(vr.id, { ...base, outcome: worst(checks.map((c) => c.outcome)) }, diffs);
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
    maps: { targetId: string | null; outcome: string }[],
  ): Promise<void> {
    // What was supposed to be unique: the key the plan matched records on, or the table's own
    // primary id when nothing else was configured. Inventing a uniqueness expectation the customer
    // never stated would produce findings about data that was always allowed to repeat.
    const snapshot = p.snapshotEntity;
    const columns =
      snapshot?.matchStrategy === 'BUSINESS_KEY' && snapshot.businessKeyFields.length
        ? snapshot.businessKeyFields
        : snapshot?.matchStrategy === 'ALTERNATE_KEY' && snapshot.alternateKey
          ? (target.keys.find((k) => k.logicalName === snapshot.alternateKey)?.attributes ?? [])
          : [target.primaryIdAttribute];
    if (columns.length === 0) {
      base.duplicateCoverage = notVerified(0, 'No key was configured for this table.');
      return;
    }

    const scan = p.tConn.findDuplicateKeys?.bind(p.tConn);
    if (!scan) {
      base.duplicateCoverage = notVerified(
        base.targetCount ?? 0,
        `${p.tConn.provider} cannot count repeated values without reading the whole table, so this check did not run.`,
      );
      checks.push({
        check: 'FIELD_VALUES',
        outcome: 'WARNING',
        message: `Duplicate keys: not verified. ${base.duplicateCoverage.reason}`,
      });
      return;
    }

    let groups;
    try {
      groups = await scan(target, columns, { maxGroups: MAX_DUPLICATE_GROUPS, idsPerGroup: 5 });
    } catch (err) {
      base.duplicateCoverage = notVerified(base.targetCount ?? 0, errorMessage(err).slice(0, 200));
      checks.push({
        check: 'FIELD_VALUES',
        outcome: 'WARNING',
        message: `Duplicate keys: not verified. ${base.duplicateCoverage.reason}`,
      });
      return;
    }

    // Whether this run is responsible. Only answerable when every record in the group is in hand:
    // with a partial sample, the records this run wrote might be the ones not sampled.
    const writtenHere = new Set(
      maps
        .filter((m) => m.targetId && (m.outcome === 'CREATED' || m.outcome === 'UPDATED'))
        .map((m) => m.targetId!.toLowerCase()),
    );
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
    base.duplicateCoverage = fullCoverage(
      base.targetCount ?? 0,
      `Counted by ${p.tConn.provider}, grouping on ${columns.join(' + ')}.`,
    );

    const total = base.duplicates.reduce((n, d) => n + d.occurrences, 0);
    if (base.duplicates.length === 0) {
      checks.push({
        check: 'FIELD_VALUES',
        outcome: 'PASS',
        message: `No repeated values of ${columns.join(' + ')} in the target.`,
      });
      return;
    }
    const ours = base.duplicates.some((d) => d.attributable === true);
    const capped = base.duplicates.length >= MAX_DUPLICATE_GROUPS ? ` (first ${MAX_DUPLICATE_GROUPS})` : '';
    checks.push({
      check: 'FIELD_VALUES',
      outcome: ours ? 'FAIL' : 'WARNING',
      message: ours
        ? `${base.duplicates.length} value(s) of ${columns.join(' + ')} are repeated across ${total} record(s)${capped}, and this run wrote at least one record in a repeated group.`
        : `${base.duplicates.length} value(s) of ${columns.join(' + ')} are repeated across ${total} record(s)${capped}. None of them were written by this run.`,
    });
  }

  private async saveEntity(validationRunId: string, result: ValidationEntityResultDto, diffs: PendingDiff[]) {
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
      checkedRecords: result.checkedRecords,
      failedInRun: result.failedInRun,
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
    if (diffs.length > capped.length) {
      result.checks.push({
        check: 'FIELD_VALUES',
        outcome: 'WARNING',
        message: `Showing ${capped.length.toLocaleString()} of ${diffs.length.toLocaleString()} differences. The counts are complete; the listed differences are the first ${MAX_DIFFERENCES_PER_TABLE.toLocaleString()}.`,
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
        checkedRecords: e.checkedRecords,
        failedInRun: e.failedInRun,
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
