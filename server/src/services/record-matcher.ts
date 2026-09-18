/**
 * Finds the existing target record for a source record, deterministically.
 *
 * Hierarchy (first hit wins):
 *   1. persisted migration identity map for this environment pair (verified to still exist)
 *   2. the strategy configured on the plan entity:
 *        PRIMARY_ID    - same record id
 *        ALTERNATE_KEY - Dataverse alternate key (guaranteed unique by the platform)
 *        BUSINESS_KEY  - configured columns; more than one hit is a CONFLICT, never a guess
 *   3. no match -> the record would be created
 *
 * Records are never matched on a display name unless it was explicitly configured as a business
 * key, and duplicate business keys inside the source are reported as conflicts.
 */
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { FieldValue, DvRecord, TableMetadata } from '../../../shared/metadata';
import { isLookupValue } from '../../../shared/metadata';
import type { AppDb } from '../db/client';
import { migrationRecordMaps } from '../db/schema';
import type { DataverseConnection } from '../dataverse/types';
import type { MatchResult, PlannerEntity, PreparedRecord } from './record-planner';

export interface MatcherScope {
  organizationId: string;
  sourceEnvironmentId: string;
  targetEnvironmentId: string;
  /** Records already mapped by this run are matched from it first. */
  runId?: string;
}

export function describeMatchStrategy(entity: {
  matchStrategy: string;
  alternateKey: string | null;
  businessKeyFields: string[];
}): string {
  if (entity.matchStrategy === 'ALTERNATE_KEY') return `${entity.alternateKey ?? '(none)'} (alternate key)`;
  if (entity.matchStrategy === 'BUSINESS_KEY') {
    return `${entity.businessKeyFields.join(' + ') || '(none)'} (configured business key)`;
  }
  return 'record id (preserved GUID)';
}

export class RecordMatcher {
  /** Source business-key values already seen in this run/preflight, to catch duplicates. */
  private readonly seenKeys = new Map<string, string>();
  /**
   * Target records already claimed in this run/preflight, keyed by `${table}:${targetId}`.
   * A target record may be claimed by at most one source record: if two source rows resolve to
   * the same target, the second is a conflict rather than an overwrite of the first.
   */
  private readonly claimedTargets = new Map<string, string>();

  constructor(
    private readonly db: AppDb,
    private readonly tConn: DataverseConnection,
    private readonly scope: MatcherScope,
  ) {}

  /**
   * Batch step: resolves identity-map hits and same-id candidates for a page of records and
   * fetches those target records once (with the columns needed for comparison).
   */
  async prefetch(
    entity: PlannerEntity,
    target: TableMetadata,
    sourceIds: string[],
    columns: string[],
  ): Promise<{ byTargetId: Map<string, DvRecord>; identity: Map<string, string> }> {
    const identity = new Map<string, string>();
    if (sourceIds.length) {
      const rows = await this.db
        .select({
          sourceId: migrationRecordMaps.sourceId,
          targetId: migrationRecordMaps.targetId,
          runId: migrationRecordMaps.runId,
          updatedAt: migrationRecordMaps.updatedAt,
        })
        .from(migrationRecordMaps)
        .where(
          and(
            eq(migrationRecordMaps.organizationId, this.scope.organizationId),
            eq(migrationRecordMaps.sourceEnvironmentId, this.scope.sourceEnvironmentId),
            eq(migrationRecordMaps.targetEnvironmentId, this.scope.targetEnvironmentId),
            eq(migrationRecordMaps.logicalName, entity.logicalName),
            inArray(
              migrationRecordMaps.sourceId,
              sourceIds.map((i) => i.toLowerCase()),
            ),
            ne(migrationRecordMaps.outcome, 'FAILED'),
            isNotNull(migrationRecordMaps.targetId),
          ),
        )
        .orderBy(desc(migrationRecordMaps.updatedAt));
      for (const r of rows) {
        const key = r.sourceId.toLowerCase();
        if (!identity.has(key) || r.runId === this.scope.runId) identity.set(key, r.targetId!);
      }
    }
    const candidateIds = new Set<string>();
    for (const id of sourceIds) {
      const mapped = identity.get(id.toLowerCase());
      if (mapped) candidateIds.add(mapped.toLowerCase());
      if (entity.matchStrategy === 'PRIMARY_ID') candidateIds.add(id.toLowerCase());
    }
    const byTargetId = new Map<string, DvRecord>();
    if (candidateIds.size) {
      const found = await this.tConn.retrieveByIds(target, [...candidateIds], columns);
      for (const r of found) byTargetId.set(r.id.toLowerCase(), r);
    }
    return { byTargetId, identity };
  }

  /**
   * Records that `sourceId` matched `targetId`, or reports a conflict when another source record
   * already claimed that target in this run.
   */
  private claim(entity: PlannerEntity, sourceId: string, result: MatchResult): MatchResult {
    if (!result.target) return result;
    const key = `${entity.logicalName}:${result.target.id.toLowerCase()}`;
    const owner = this.claimedTargets.get(key);
    if (owner && owner !== sourceId.toLowerCase()) {
      return {
        target: null,
        method: null,
        conflict: {
          code: 'DUPLICATE_SOURCE_KEY',
          reason: `Source record ${owner} already migrates into this target record; two source records cannot both own it`,
        },
      };
    }
    this.claimedTargets.set(key, sourceId.toLowerCase());
    return result;
  }

  /** Resolves the match for one record. `prefetched` comes from {@link prefetch}. */
  async match(
    entity: PlannerEntity,
    target: TableMetadata,
    record: { id: string },
    prepared: PreparedRecord,
    prefetched: { byTargetId: Map<string, DvRecord>; identity: Map<string, string> },
    columns: string[],
  ): Promise<MatchResult> {
    return this.claim(
      entity,
      record.id,
      await this.resolve(entity, target, record, prepared, prefetched, columns),
    );
  }

  private async resolve(
    entity: PlannerEntity,
    target: TableMetadata,
    record: { id: string },
    prepared: PreparedRecord,
    prefetched: { byTargetId: Map<string, DvRecord>; identity: Map<string, string> },
    columns: string[],
  ): Promise<MatchResult> {
    // 1. identity map (verified: the record must still exist in the target)
    const mapped = prefetched.identity.get(record.id.toLowerCase());
    if (mapped) {
      const existing = prefetched.byTargetId.get(mapped.toLowerCase());
      if (existing) return { target: existing, method: 'IDENTITY_MAP' };
    }

    // 2. configured strategy
    if (entity.matchStrategy === 'PRIMARY_ID') {
      const existing = prefetched.byTargetId.get(record.id.toLowerCase());
      return existing ? { target: existing, method: 'PRIMARY_ID' } : { target: null, method: null };
    }

    if (entity.matchStrategy === 'ALTERNATE_KEY') {
      const key = target.keys.find((k) => k.logicalName === entity.alternateKey);
      if (!key) {
        return {
          target: null,
          method: null,
          conflict: {
            code: 'ALTERNATE_KEY_MISSING',
            reason: `Alternate key ${entity.alternateKey ?? '(none)'} is not defined in the target`,
          },
        };
      }
      const duplicate = this.rememberKey(entity.logicalName, key.attributes, prepared, record.id);
      if (duplicate) return duplicate;
      const match = await this.tConn.findByAlternateKey(target, key, prepared.values, columns);
      return match
        ? { target: match, method: `ALTERNATE_KEY:${key.logicalName}` }
        : { target: null, method: null };
    }

    // BUSINESS_KEY
    const fields = entity.businessKeyFields ?? [];
    if (fields.length === 0) {
      return {
        target: null,
        method: null,
        conflict: {
          code: 'BUSINESS_KEY_NOT_CONFIGURED',
          reason: 'No business key columns are configured for this table',
        },
      };
    }
    const criteria: Record<string, FieldValue> = {};
    for (const f of fields) {
      const value = prepared.values[f];
      if (value === undefined || value === null) {
        return {
          target: null,
          method: null,
          conflict: {
            code: 'BUSINESS_KEY_INCOMPLETE',
            reason: `Business key column ${f} is empty for this record, so no safe match can be made`,
          },
        };
      }
      criteria[f] = value;
    }
    const duplicate = this.rememberKey(entity.logicalName, fields, prepared, record.id);
    if (duplicate) return duplicate;
    const candidates = await this.tConn.findByFields(target, criteria, columns, 2);
    if (candidates.length > 1) {
      return {
        target: null,
        method: null,
        conflict: {
          code: 'AMBIGUOUS_TARGET_MATCH',
          reason: `${candidates.length}+ target records match the business key ${fields.join(' + ')}; resolve the duplicates in the target or choose a different match strategy`,
        },
      };
    }
    return candidates.length === 1
      ? { target: candidates[0], method: `BUSINESS_KEY:${fields.join('+')}` }
      : { target: null, method: null };
  }

  /** Detects two source records carrying the same key, which cannot both be matched safely. */
  private rememberKey(
    logicalName: string,
    fields: string[],
    prepared: PreparedRecord,
    sourceId: string,
  ): MatchResult | null {
    const parts = fields.map((f) => {
      const v = prepared.values[f];
      return isLookupValue(v) ? v.id : String(v ?? '');
    });
    const key = `${logicalName}|${parts.join('|').toLowerCase()}`;
    const first = this.seenKeys.get(key);
    if (first && first !== sourceId.toLowerCase()) {
      return {
        target: null,
        method: null,
        conflict: {
          code: 'DUPLICATE_SOURCE_KEY',
          reason: `Source record ${first} has the same key (${fields.join(' + ')}); duplicates cannot be matched safely`,
        },
      };
    }
    this.seenKeys.set(key, sourceId.toLowerCase());
    return null;
  }
}
