import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  ComparisonDifferenceDto,
  ComparisonSuggestionDto,
  ComparisonTablePairDto,
  ComparisonTotalsDto,
  DataComparisonDto,
  DataComparisonListItemDto,
  DataComparisonOptions,
  DataComparisonTableResultDto,
  ValidationCheckDto,
  ValidationOutcome,
} from '../../../shared/domain';
import type { DvRecord, TableMetadata } from '../../../shared/metadata';
import type { ConnectionFactory } from '../dataverse/factory';
import type { MigrationConnector } from '../connectors/types';
import type { AppDb } from '../db/client';
import {
  dataComparisonDifferences,
  dataComparisons,
  dataComparisonTables,
  environments,
  users,
} from '../db/schema';
import type { JobQueue } from '../jobs/queue';
import { badRequest, errorMessage, notFound } from '../lib/errors';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import {
  addTotals,
  buildSuggestion,
  emptyComparisonTotals,
  fieldGaps,
  indexSide,
  pairSides,
  renderKey,
  suggestTablePairs,
  totalsReconcile,
} from './data-comparison';
import type { EnvironmentService } from './environment-service';
import { envRef } from './env-ref';
import type { MetadataService } from './metadata-service';
import type { ProjectService } from './project-service';
import { compareRecords } from './validation-service';

/**
 * Comparison and validation as a service in its own right.
 *
 * The question is not "did my migration work" — that is what validation answers, against a run it
 * knows about. This one answers "do these two datasets agree?", for any two datasets, with no
 * migration involved and nothing written on either side. Reconciling a finance extract against the
 * system of record every month is the same job as checking a migration a year later.
 *
 * Nothing here compares values. That belongs to `compareRecords`, which the migration validation
 * already uses: one implementation of "are these the same value", so a comparison run and a
 * validation run can never disagree about the same two records.
 */

/** Tables in one comparison. Beyond this it is a batch job, not something somebody is watching. */
const MAX_TABLES_PER_COMPARISON = 50;
/**
 * Records read per side, per table.
 *
 * Pairing is a hash join, so both sides are held in memory. The cap is the honest limit of that,
 * and hitting it is reported rather than absorbed — with a warning that "only on one side" cannot
 * be concluded from a partial read, because the missing record may simply be past the cap.
 */
const MAX_RECORDS_PER_SIDE = 50_000;
const MAX_DIFFERENCES_PER_TABLE = 2_000;

const RANK: Record<ValidationOutcome, number> = { PASS: 0, WARNING: 1, FAIL: 2 };
const worst = (outcomes: ValidationOutcome[]): ValidationOutcome =>
  outcomes.reduce<ValidationOutcome>((w, o) => (RANK[o] > RANK[w] ? o : w), 'PASS');

interface PendingRow {
  leftTable: string;
  keyValue: string;
  differenceType: ComparisonDifferenceDto['differenceType'];
  field: string | null;
  leftValue: string | null;
  rightValue: string | null;
}

export class DataComparisonService {
  constructor(
    private readonly db: AppDb,
    private readonly projectsSvc: ProjectService,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // Setting one up
  // ---------------------------------------------------------------------------

  /**
   * Proposes what to compare, so the setup screen is a confirmation rather than data entry.
   *
   * Nothing proposed is ever run without being confirmed — the same rule the mapping engine
   * follows. A proposal with no usable key says so instead of guessing one.
   */
  async suggest(ctx: RequestContext, projectId: string): Promise<ComparisonSuggestionDto[]> {
    const { project, left, right } = await this.sides(ctx, projectId);
    const [lConn, rConn] = await Promise.all([
      this.connections.connectorFor(left, ctx.userId, { projectId }),
      this.connections.connectorFor(right, ctx.userId, { projectId }),
    ]);
    const [lCatalog, rCatalog] = await Promise.all([
      this.metadata.getCatalog(left.id, lConn),
      this.metadata.getCatalog(right.id, rConn),
    ]);
    const paired = suggestTablePairs(lCatalog, rCatalog).slice(0, MAX_TABLES_PER_COMPARISON);
    if (paired.length === 0) return [];

    const [lMeta, rMeta] = await Promise.all([
      this.metadata.getTables(
        left.id,
        lConn,
        paired.map((p) => p.left.logicalName),
      ),
      this.metadata.getTables(
        right.id,
        rConn,
        paired.map((p) => p.right.logicalName),
      ),
    ]);
    this.logger.info({ projectId: project.id, pairs: paired.length }, 'Comparison pairs suggested');
    return paired
      .map((p) => {
        const l = lMeta.get(p.left.logicalName);
        const r = rMeta.get(p.right.logicalName);
        if (!l || !r) return null;
        return buildSuggestion(
          l,
          r,
          p.score === 1 ? 'The names match' : `The names are ${Math.round(p.score * 100)}% similar`,
        );
      })
      .filter((s): s is ComparisonSuggestionDto => s !== null);
  }

  async create(
    ctx: RequestContext,
    projectId: string,
    input: { name?: string; pairs: ComparisonTablePairDto[] },
  ): Promise<DataComparisonDto> {
    const { project, left, right } = await this.sides(ctx, projectId);
    const pairs = this.validatePairs(input.pairs);
    const options: DataComparisonOptions = { pairs };
    const name = (input.name ?? '').trim() || defaultName(pairs);

    const [run] = await this.db
      .insert(dataComparisons)
      .values({
        organizationId: ctx.organizationId,
        projectId: project.id,
        leftEnvironmentId: left.id,
        rightEnvironmentId: right.id,
        name,
        status: 'QUEUED',
        options,
        progressMessage: 'Queued',
        createdByUserId: ctx.userId,
      })
      .returning();
    await this.queue.enqueue('DATA_COMPARISON', ctx.organizationId, run.id);
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'DATA_COMPARISON_REQUESTED',
      outcome: 'REQUESTED',
      sourceEnvironmentId: left.id,
      targetEnvironmentId: right.id,
      requestId: ctx.requestId,
      details: { dataComparisonId: run.id, projectId, tables: pairs.length },
    });
    this.logger.info({ dataComparisonId: run.id, projectId }, 'Data comparison queued');
    return this.get(ctx, run.id);
  }

  private validatePairs(pairs: ComparisonTablePairDto[]): ComparisonTablePairDto[] {
    if (!pairs?.length) throw badRequest('Choose at least one pair of tables to compare');
    if (pairs.length > MAX_TABLES_PER_COMPARISON) {
      throw badRequest(`A comparison covers at most ${MAX_TABLES_PER_COMPARISON} table pairs at a time`);
    }
    const seen = new Set<string>();
    return pairs.map((p) => {
      const leftTable = p.leftTable?.trim();
      const rightTable = p.rightTable?.trim();
      if (!leftTable || !rightTable) throw badRequest('Each pair needs a table on both sides');
      if (seen.has(leftTable)) {
        throw badRequest(
          `${leftTable} appears twice. Compare it against one table at a time, so a record on the left has one answer rather than two.`,
        );
      }
      seen.add(leftTable);
      const key = (p.key ?? []).filter((k) => k.left?.trim() && k.right?.trim());
      if (key.length === 0) {
        throw badRequest(
          `Choose the column that identifies the same record on both sides for ${leftTable}. Without one there is nothing to match records on.`,
        );
      }
      return {
        leftTable,
        rightTable,
        key: key.map((k) => ({ left: k.left.trim(), right: k.right.trim() })),
        fields: (p.fields ?? [])
          .filter((f) => f.left?.trim() && f.right?.trim())
          .map((f) => ({ left: f.left.trim(), right: f.right.trim() })),
      };
    });
  }

  /** The project and its two sides, refusing anything that is not a comparison project. */
  private async sides(ctx: RequestContext, projectId: string) {
    const project = await this.projectsSvc.ofKind(ctx, projectId, 'COMPARISON');
    if (!project.sourceEnvironmentId || !project.targetEnvironmentId) {
      throw badRequest('Choose both sides of this comparison before running it');
    }
    const [left, right] = await Promise.all([
      this.environmentsSvc.getAccessible(ctx, project.sourceEnvironmentId),
      this.environmentsSvc.getAccessible(ctx, project.targetEnvironmentId),
    ]);
    return { project, left, right };
  }

  // ---------------------------------------------------------------------------
  // Running it
  // ---------------------------------------------------------------------------

  async execute(runId: string, heartbeat: () => Promise<void> = async () => {}): Promise<void> {
    const [run] = await this.db.select().from(dataComparisons).where(eq(dataComparisons.id, runId));
    if (!run || run.status === 'COMPLETED') return;

    const progress = (progressMessage: string) =>
      this.db.update(dataComparisons).set({ progressMessage }).where(eq(dataComparisons.id, runId));

    let lConn: MigrationConnector | undefined;
    let rConn: MigrationConnector | undefined;
    try {
      await this.db
        .update(dataComparisons)
        .set({ status: 'RUNNING', startedAt: new Date(), errorMessage: null, progressMessage: 'Starting' })
        .where(eq(dataComparisons.id, runId));
      // A re-run replaces its own output rather than adding to it.
      await this.db.delete(dataComparisonTables).where(eq(dataComparisonTables.dataComparisonId, runId));
      await this.db
        .delete(dataComparisonDifferences)
        .where(eq(dataComparisonDifferences.dataComparisonId, runId));

      const [left, right] = await Promise.all([
        this.environmentsSvc.getInOrganization(run.organizationId, run.leftEnvironmentId),
        this.environmentsSvc.getInOrganization(run.organizationId, run.rightEnvironmentId),
      ]);
      const userId = run.createdByUserId ?? '';
      lConn = await this.connections.connectorFor(left, userId, { dataComparisonId: runId });
      rConn = await this.connections.connectorFor(right, userId, { dataComparisonId: runId });

      let totals = emptyComparisonTotals();
      const outcomes: ValidationOutcome[] = [];
      for (const [i, pair] of run.options.pairs.entries()) {
        await heartbeat();
        await progress(`Comparing ${pair.leftTable} (${i + 1}/${run.options.pairs.length})`);
        const result = await this.comparePair({
          runId,
          pair,
          lConn,
          rConn,
          leftEnvId: left.id,
          rightEnvId: right.id,
        });
        totals = addTotals(totals, result);
        outcomes.push(result.outcome);
      }

      await this.db
        .update(dataComparisons)
        .set({
          status: 'COMPLETED',
          outcome: worst(outcomes),
          totals,
          completedAt: new Date(),
          progressMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(dataComparisons.id, runId));
      await this.audit.record({
        organizationId: run.organizationId,
        userId: run.createdByUserId,
        action: 'DATA_COMPARISON_COMPLETED',
        outcome: 'SUCCESS',
        sourceEnvironmentId: run.leftEnvironmentId,
        targetEnvironmentId: run.rightEnvironmentId,
        requestId: `comparison-${runId}`,
        details: { dataComparisonId: runId, ...totals },
      });
      this.logger.info({ dataComparisonId: runId, ...totals }, 'Data comparison completed');
    } catch (err) {
      await this.db
        .update(dataComparisons)
        .set({
          status: 'FAILED',
          errorMessage: errorMessage(err),
          completedAt: new Date(),
          progressMessage: null,
        })
        .where(eq(dataComparisons.id, runId));
      this.logger.error({ err, dataComparisonId: runId }, 'Data comparison failed');
      throw err;
    } finally {
      await lConn?.dispose?.();
      await rConn?.dispose?.();
    }
  }

  /**
   * One table pair: read both sides, pair by key, compare the paired records field by field.
   */
  private async comparePair(p: {
    runId: string;
    pair: ComparisonTablePairDto;
    lConn: MigrationConnector;
    rConn: MigrationConnector;
    leftEnvId: string;
    rightEnvId: string;
  }): Promise<ComparisonTotalsDto & { outcome: ValidationOutcome }> {
    const { pair } = p;
    const checks: ValidationCheckDto[] = [];
    const rows: PendingRow[] = [];
    const totals = emptyComparisonTotals();

    const [leftMeta, rightMeta] = await Promise.all([
      this.metadata.getTable(p.leftEnvId, p.lConn, pair.leftTable).catch(() => undefined),
      this.metadata.getTable(p.rightEnvId, p.rConn, pair.rightTable).catch(() => undefined),
    ]);
    if (!leftMeta || !rightMeta) {
      return this.saveTable(p.runId, {
        ...blankResult(pair, `${pair.leftTable} ↔ ${pair.rightTable}`),
        outcome: 'FAIL',
        checks: [
          {
            check: 'SCHEMA',
            outcome: 'FAIL',
            message: `Table is missing on the ${!leftMeta ? 'left' : 'right'} side`,
          },
        ],
      });
    }

    const displayName = `${leftMeta.displayName} ↔ ${rightMeta.displayName}`;
    const lAttrs = new Map(leftMeta.attributes.map((a) => [a.logicalName, a]));
    const rAttrs = new Map(rightMeta.attributes.map((a) => [a.logicalName, a]));

    // The key has to exist on both sides, or nothing below means anything.
    const missingKey = [
      ...pair.key.filter((k) => !lAttrs.has(k.left)).map((k) => `${k.left} (left)`),
      ...pair.key.filter((k) => !rAttrs.has(k.right)).map((k) => `${k.right} (right)`),
    ];
    if (missingKey.length) {
      return this.saveTable(p.runId, {
        ...blankResult(pair, displayName),
        outcome: 'FAIL',
        checks: [
          {
            check: 'SCHEMA',
            outcome: 'FAIL',
            message: `The key column(s) ${missingKey.join(', ')} do not exist, so records cannot be matched`,
          },
        ],
      });
    }

    // Fields that exist on both sides. One named in the request but missing is reported, not dropped.
    const fields = pair.fields.filter((f) => lAttrs.has(f.left) && rAttrs.has(f.right));
    const unusable = pair.fields.filter((f) => !lAttrs.has(f.left) || !rAttrs.has(f.right));
    if (unusable.length) {
      checks.push({
        check: 'SCHEMA',
        outcome: 'WARNING',
        message: `${unusable.length} requested column(s) do not exist on both sides and were not compared: ${unusable
          .map((f) => `${f.left} ↔ ${f.right}`)
          .join(', ')}`,
      });
    }

    const gaps = fieldGaps(leftMeta, rightMeta);
    checks.push(
      gaps.onlyInLeft.length === 0 && gaps.onlyInRight.length === 0
        ? { check: 'SCHEMA', outcome: 'PASS', message: 'Both sides have the same columns' }
        : {
            check: 'SCHEMA',
            outcome: 'WARNING',
            message: `${gaps.onlyInLeft.length} column(s) exist only on the left and ${gaps.onlyInRight.length} only on the right. A column missing on one side is never a value difference — it is reported here instead.`,
          },
    );

    // Row counts, from each side directly rather than from what was read.
    const [lCount, rCount] = await Promise.all([
      p.lConn.countRecords(leftMeta).catch(() => ({ count: null, approximate: false })),
      p.rConn.countRecords(rightMeta).catch(() => ({ count: null, approximate: false })),
    ]);

    const leftColumns = [...new Set([...pair.key.map((k) => k.left), ...fields.map((f) => f.left)])];
    const rightColumns = [...new Set([...pair.key.map((k) => k.right), ...fields.map((f) => f.right)])];
    const [leftRead, rightRead] = await Promise.all([
      readSide(p.lConn, leftMeta, leftColumns),
      readSide(p.rConn, rightMeta, rightColumns),
    ]);

    const leftSide = indexSide(
      leftRead.records,
      pair.key.map((k) => k.left),
      leftMeta,
    );
    const rightSide = indexSide(
      rightRead.records,
      pair.key.map((k) => k.right),
      rightMeta,
    );
    const { pairs: paired, onlyInRight } = pairSides(leftSide, rightSide);

    // The canonical field comparison — the same code validation runs. Lookups are compared by the
    // id they point at, which is what `normalizeForCompare` does with them on either side.
    const keyByRecordId = new Map(paired.map((x) => [x.left.id, x.key]));
    const comparison = compareRecords({
      source: leftMeta,
      target: rightMeta,
      mappings: fields.map((f) => ({ sourceField: f.left, targetField: f.right, isLookup: false })),
      pairs: paired.map((x) => ({ source: x.left, target: x.right, outcome: 'UNMAPPED' as const })),
      expectedLookup: () => null,
    });

    for (const d of comparison.diffs) {
      const keyValue = renderKey(keyByRecordId.get(d.sourceRecordId ?? '') ?? '');
      if (d.differenceType === 'MISSING_IN_TARGET') {
        rows.push({
          leftTable: pair.leftTable,
          keyValue,
          differenceType: 'ONLY_IN_LEFT',
          field: null,
          leftValue: null,
          rightValue: null,
        });
      } else {
        rows.push({
          leftTable: pair.leftTable,
          keyValue,
          differenceType: 'VALUE_DIFFERS',
          field: d.field,
          leftValue: d.sourceValue,
          rightValue: d.targetValue,
        });
      }
    }
    for (const r of onlyInRight) {
      rows.push({
        leftTable: pair.leftTable,
        keyValue: renderKey(r.key),
        differenceType: 'ONLY_IN_RIGHT',
        field: null,
        leftValue: null,
        rightValue: null,
      });
    }
    for (const [side, keyed] of [
      ['left', leftSide],
      ['right', rightSide],
    ] as const) {
      for (const [key, n] of keyed.duplicates) {
        rows.push({
          leftTable: pair.leftTable,
          keyValue: renderKey(key),
          differenceType: 'DUPLICATE_KEY',
          field: null,
          leftValue: side === 'left' ? `${n} records on the left` : null,
          rightValue: side === 'right' ? `${n} records on the right` : null,
        });
      }
      for (const record of keyed.blank) {
        rows.push({
          leftTable: pair.leftTable,
          keyValue: `(no key: ${record.id})`,
          differenceType: 'BLANK_KEY',
          field: null,
          leftValue: side === 'left' ? 'on the left' : null,
          rightValue: side === 'right' ? 'on the right' : null,
        });
      }
    }

    totals.leftRecords = leftSide.total;
    totals.rightRecords = rightSide.total;
    totals.leftExcluded = leftSide.excluded;
    totals.rightExcluded = rightSide.excluded;
    totals.matched = comparison.matched;
    totals.different = comparison.different;
    totals.onlyInLeft = comparison.missing;
    totals.onlyInRight = onlyInRight.length;
    totals.duplicateKeys =
      [...leftSide.duplicates.values()].reduce((a, b) => a + b, 0) +
      [...rightSide.duplicates.values()].reduce((a, b) => a + b, 0);
    totals.blankKeys = leftSide.blank.length + rightSide.blank.length;
    totals.fieldDifferences = comparison.diffs.filter((d) => d.field !== null).length;

    if (!totalsReconcile(totals)) {
      // Not a user error: an internal one. Refusing to store an unreconciled result is the whole
      // point of computing the identity — a number nobody can add up is worse than no number.
      throw new Error(
        `Comparison totals for ${pair.leftTable} do not reconcile: ${JSON.stringify(totals)}. The result was not stored.`,
      );
    }

    checks.push(
      lCount.count === rCount.count
        ? {
            check: 'ROW_COUNT',
            outcome: 'PASS',
            message: `Both sides hold ${lCount.count ?? '?'} row(s)`,
          }
        : {
            check: 'ROW_COUNT',
            outcome: 'WARNING',
            message: `Row counts differ: ${lCount.count ?? '?'} on the left, ${rCount.count ?? '?'} on the right`,
          },
    );
    if (fields.length === 0) {
      checks.push({
        check: 'FIELD_VALUES',
        outcome: 'PASS',
        message: 'Keys only: this compared which records exist, not what they contain',
      });
    } else {
      checks.push(
        totals.different === 0
          ? {
              check: 'FIELD_VALUES',
              outcome: 'PASS',
              message: `${totals.matched.toLocaleString()} record(s) agree on all ${fields.length} compared column(s)`,
            }
          : {
              check: 'FIELD_VALUES',
              outcome: 'FAIL',
              message: `${totals.different.toLocaleString()} record(s) differ, across ${totals.fieldDifferences.toLocaleString()} field value(s)`,
            },
      );
    }
    // A key that matches nothing produces a page of zeroes, and zeroes read as "all clear" unless
    // something says otherwise. This is that something: the first run of this feature reported
    // "every record appears on both sides" while it had in fact compared none of them.
    const comparable = totals.leftRecords - totals.leftExcluded;
    const comparableRight = totals.rightRecords - totals.rightExcluded;
    if ((totals.leftRecords > 0 && comparable === 0) || (totals.rightRecords > 0 && comparableRight === 0)) {
      checks.push({
        check: 'RECORD_EXISTENCE',
        outcome: 'FAIL',
        message: `Nothing was compared: no record on the ${comparable === 0 ? 'left' : 'right'} had a usable key. Check that ${pair.key
          .map((k) => `${k.left} ↔ ${k.right}`)
          .join(
            ', ',
          )} identifies a record on both sides — this result says nothing about whether the data agrees.`,
      });
    }
    checks.push(
      totals.onlyInLeft === 0 && totals.onlyInRight === 0 && comparable > 0
        ? { check: 'RECORD_EXISTENCE', outcome: 'PASS', message: 'Every record appears on both sides' }
        : {
            check: 'RECORD_EXISTENCE',
            outcome: 'FAIL',
            message:
              `${totals.onlyInLeft.toLocaleString()} record(s) exist only on the left and ${totals.onlyInRight.toLocaleString()} only on the right` +
              // Unmatched records on both sides usually means the key did not line up rather than
              // that the data is missing: a key differing only in case or leading whitespace is a
              // different key here, exactly as it is a different value everywhere else in the
              // product. Saying so costs a sentence and saves the first hour of investigation.
              (totals.onlyInLeft > 0 && totals.onlyInRight > 0
                ? '. Unmatched on both sides at once often means the key itself does not line up — a key differing only in case or leading whitespace counts as a different key, so the same record appears in both lists.'
                : ''),
          },
    );
    if (totals.duplicateKeys || totals.blankKeys) {
      checks.push({
        check: 'RECORD_EXISTENCE',
        outcome: 'WARNING',
        message: `${totals.duplicateKeys.toLocaleString()} record(s) share a key with another and ${totals.blankKeys.toLocaleString()} have no key at all. They are listed but not compared: with a key that does not identify one record, there is no honest answer to what it matches.`,
      });
    }
    if (leftRead.truncated || rightRead.truncated) {
      checks.push({
        check: 'RECORD_EXISTENCE',
        outcome: 'WARNING',
        message: `Only the first ${MAX_RECORDS_PER_SIDE.toLocaleString()} record(s) of the ${leftRead.truncated && rightRead.truncated ? 'two sides' : leftRead.truncated ? 'left side' : 'right side'} were read. Treat "only on one side" as provisional: a record beyond the cap looks missing when it is not.`,
      });
    }

    return this.saveTable(
      p.runId,
      {
        leftTable: pair.leftTable,
        rightTable: pair.rightTable,
        displayName,
        outcome: worst(checks.map((c) => c.outcome)),
        leftCount: lCount.count,
        rightCount: rCount.count,
        leftTruncated: leftRead.truncated,
        rightTruncated: rightRead.truncated,
        comparedFields: fields,
        fieldsOnlyInLeft: gaps.onlyInLeft,
        fieldsOnlyInRight: gaps.onlyInRight,
        checks,
        ...totals,
      },
      rows,
    );
  }

  private async saveTable(
    runId: string,
    result: DataComparisonTableResultDto,
    rows: PendingRow[] = [],
  ): Promise<ComparisonTotalsDto & { outcome: ValidationOutcome }> {
    const capped = rows.slice(0, MAX_DIFFERENCES_PER_TABLE);
    if (rows.length > capped.length) {
      // Same disclosure as everywhere else: the counts are complete, the list is not.
      result.checks.push({
        check: 'FIELD_VALUES',
        outcome: 'WARNING',
        message: `Showing ${capped.length.toLocaleString()} of ${rows.length.toLocaleString()} differences. The counts above are complete; the listed rows are the first ${MAX_DIFFERENCES_PER_TABLE.toLocaleString()}.`,
      });
    }
    await this.db.insert(dataComparisonTables).values({
      dataComparisonId: runId,
      leftTable: result.leftTable,
      rightTable: result.rightTable,
      displayName: result.displayName,
      outcome: result.outcome,
      leftCount: result.leftCount,
      rightCount: result.rightCount,
      leftTruncated: result.leftTruncated,
      rightTruncated: result.rightTruncated,
      totals: totalsOf(result),
      comparedFields: result.comparedFields,
      fieldsOnlyInLeft: result.fieldsOnlyInLeft,
      fieldsOnlyInRight: result.fieldsOnlyInRight,
      checks: result.checks,
    });
    for (let i = 0; i < capped.length; i += 200) {
      await this.db
        .insert(dataComparisonDifferences)
        .values(capped.slice(i, i + 200).map((r) => ({ dataComparisonId: runId, ...r })));
    }
    return { ...totalsOf(result), outcome: result.outcome };
  }

  // ---------------------------------------------------------------------------
  // Reading results
  // ---------------------------------------------------------------------------

  async get(ctx: Pick<RequestContext, 'organizationId'>, id: string): Promise<DataComparisonDto> {
    const [row] = await this.db
      .select()
      .from(dataComparisons)
      .where(and(eq(dataComparisons.id, id), eq(dataComparisons.organizationId, ctx.organizationId)));
    if (!row) throw notFound('Comparison');

    const tables = await this.db
      .select()
      .from(dataComparisonTables)
      .where(eq(dataComparisonTables.dataComparisonId, id))
      .orderBy(asc(dataComparisonTables.displayName));
    const envRows = await this.db
      .select()
      .from(environments)
      .where(inArray(environments.id, [row.leftEnvironmentId, row.rightEnvironmentId]));
    const byId = new Map(envRows.map((e) => [e.id, envRef(e)]));
    const [creator] = row.createdByUserId
      ? await this.db
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, row.createdByUserId))
      : [];

    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      status: row.status,
      outcome: row.outcome,
      leftEnvironment: byId.get(row.leftEnvironmentId) ?? null,
      rightEnvironment: byId.get(row.rightEnvironmentId) ?? null,
      options: row.options,
      totals: row.totals ?? emptyComparisonTotals(),
      tables: tables.map((t) => ({
        leftTable: t.leftTable,
        rightTable: t.rightTable,
        displayName: t.displayName,
        outcome: t.outcome,
        leftCount: t.leftCount,
        rightCount: t.rightCount,
        leftTruncated: t.leftTruncated,
        rightTruncated: t.rightTruncated,
        comparedFields: t.comparedFields,
        fieldsOnlyInLeft: t.fieldsOnlyInLeft,
        fieldsOnlyInRight: t.fieldsOnlyInRight,
        checks: t.checks as ValidationCheckDto[],
        ...t.totals,
      })),
      progressMessage: row.progressMessage,
      errorMessage: row.errorMessage,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdBy: creator?.displayName ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(ctx: RequestContext, projectId: string): Promise<DataComparisonListItemDto[]> {
    await this.projectsSvc.ofKind(ctx, projectId, 'COMPARISON');
    const rows = await this.db
      .select()
      .from(dataComparisons)
      .where(
        and(eq(dataComparisons.projectId, projectId), eq(dataComparisons.organizationId, ctx.organizationId)),
      )
      .orderBy(desc(dataComparisons.createdAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      outcome: r.outcome,
      totals: r.totals ?? emptyComparisonTotals(),
      tableCount: r.options.pairs.length,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    }));
  }

  async differences(
    ctx: Pick<RequestContext, 'organizationId'>,
    id: string,
    filter: { table?: string; type?: string; limit?: number; offset?: number } = {},
  ): Promise<{ rows: ComparisonDifferenceDto[]; total: number }> {
    // Ownership first: the id alone must never be enough to read somebody else's results.
    await this.get(ctx, id);
    const where = [eq(dataComparisonDifferences.dataComparisonId, id)];
    if (filter.table) where.push(eq(dataComparisonDifferences.leftTable, filter.table));
    if (filter.type)
      where.push(
        eq(
          dataComparisonDifferences.differenceType,
          filter.type as ComparisonDifferenceDto['differenceType'],
        ),
      );
    const rows = await this.db
      .select()
      .from(dataComparisonDifferences)
      .where(and(...where))
      .orderBy(asc(dataComparisonDifferences.leftTable), asc(dataComparisonDifferences.keyValue))
      .limit(Math.min(filter.limit ?? 200, 1000))
      .offset(filter.offset ?? 0);
    const all = await this.db
      .select({ id: dataComparisonDifferences.id })
      .from(dataComparisonDifferences)
      .where(and(...where));
    return {
      total: all.length,
      rows: rows.map((r) => ({
        leftTable: r.leftTable,
        keyValue: r.keyValue,
        differenceType: r.differenceType,
        field: r.field,
        leftValue: r.leftValue,
        rightValue: r.rightValue,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads one side up to the cap, reporting whether the cap is what stopped it.
 *
 * Every connector returns the primary key as `record.id` rather than as an entry in `values`, so a
 * comparison keyed on the primary id — the most obvious key there is — saw an empty value on every
 * single record. Putting it back here means the key builder, the value comparison and the reports
 * all see one consistent record, rather than each having to remember this.
 */
async function readSide(
  conn: MigrationConnector,
  meta: TableMetadata,
  columns: string[],
): Promise<{ records: DvRecord[]; truncated: boolean }> {
  const pk = meta.primaryIdAttribute;
  const withId = (r: DvRecord): DvRecord =>
    pk && r.values[pk] === undefined ? { ...r, values: { ...r.values, [pk]: r.id } } : r;

  const records: DvRecord[] = [];
  for await (const page of conn.queryRecords(meta, columns, { pageSize: 500 })) {
    records.push(...page.map(withId));
    if (records.length >= MAX_RECORDS_PER_SIDE) {
      return { records: records.slice(0, MAX_RECORDS_PER_SIDE), truncated: true };
    }
  }
  return { records, truncated: false };
}

const totalsOf = (r: DataComparisonTableResultDto): ComparisonTotalsDto => ({
  leftRecords: r.leftRecords,
  rightRecords: r.rightRecords,
  leftExcluded: r.leftExcluded,
  rightExcluded: r.rightExcluded,
  matched: r.matched,
  different: r.different,
  onlyInLeft: r.onlyInLeft,
  onlyInRight: r.onlyInRight,
  duplicateKeys: r.duplicateKeys,
  blankKeys: r.blankKeys,
  fieldDifferences: r.fieldDifferences,
});

const blankResult = (pair: ComparisonTablePairDto, displayName: string): DataComparisonTableResultDto => ({
  leftTable: pair.leftTable,
  rightTable: pair.rightTable,
  displayName,
  outcome: 'PASS',
  leftCount: null,
  rightCount: null,
  leftTruncated: false,
  rightTruncated: false,
  comparedFields: [],
  fieldsOnlyInLeft: [],
  fieldsOnlyInRight: [],
  checks: [],
  ...emptyComparisonTotals(),
});

const defaultName = (pairs: ComparisonTablePairDto[]) =>
  pairs.length === 1 ? `${pairs[0].leftTable} vs ${pairs[0].rightTable}` : `${pairs.length} tables compared`;
