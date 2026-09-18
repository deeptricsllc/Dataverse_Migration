/**
 * Decides what a migration would do with one source record.
 *
 * The preflight (dry run) and the execution engine both use this module, so the classification a
 * user reviews is produced by exactly the code that later writes. Nothing here performs I/O: the
 * caller supplies the already-fetched target record and the resolved identities.
 */
import {
  auditFlags,
  type FieldChangeDto,
  type PlanOptions,
  type PreflightAction,
} from '../../../shared/domain';
import {
  LOOKUP_TYPES,
  SYSTEM_MANAGED_COLUMNS,
  isLookupValue,
  type AttributeMeta,
  type DvRecord,
  type FieldValue,
  type LookupValue,
  type TableMetadata,
} from '../../../shared/metadata';
import type { RunPlanSnapshot } from './run-snapshot';
import { transformField } from './transforms';
import { displayValue, valuesEqual } from './values';

export type PlannerEntity = RunPlanSnapshot['entities'][number];

export interface RecordIssue {
  severity: 'ERROR' | 'WARNING';
  code: string;
  field?: string | null;
  message: string;
  retryable: boolean;
}

export interface PreparedRecord {
  sourceId: string;
  name: string | null;
  /** Target column values for a create. */
  values: Record<string, FieldValue>;
  /** Lookups deferred to pass 2 (circular dependencies). */
  deferred: Record<string, LookupValue>;
  /** Ownership/audit fields where the configured fallback identity was substituted. */
  principalFallbacks: string[];
  /** Target user to impersonate on create (preserving "created by"). */
  impersonateUserId: string | null;
  /** Pass 3 work to re-stamp "modified by". */
  auditWork: { modifiedById: string; field: string; value: FieldValue } | null;
  issues: RecordIssue[];
  /** Set when the record cannot be migrated safely. */
  blocked: { code: string; reason: string } | null;
}

export interface PrepareInput {
  entity: PlannerEntity;
  options: PlanOptions;
  source: TableMetadata;
  target: TableMetadata;
  record: DvRecord;
  /** `${logicalName}:${sourceId}` -> target id, for users/teams/business units. */
  principalMap: ReadonlyMap<string, string>;
  /** Resolved business-data lookups: `${logicalName}:${sourceId}` -> target id (null = unresolved). */
  lookups: ReadonlyMap<string, string | null>;
  /**
   * Dry-run only: lookups whose target record does not exist yet but which this plan would create
   * in an earlier pass. They are reported as pending instead of blocking, because the execution
   * order guarantees they will exist by the time the record is written.
   */
  pendingLookups?: ReadonlySet<string>;
}

const lookupKey = (logicalName: string, id: string) => `${logicalName}:${id.toLowerCase()}`;
const isRequired = (a: AttributeMeta) =>
  a.requiredLevel === 'ApplicationRequired' || a.requiredLevel === 'SystemRequired';

/** Builds the values a create would send, plus every issue found while doing so. */
export function prepareRecord(input: PrepareInput): PreparedRecord {
  const { entity, options, source, target, record } = input;
  const flags = auditFlags(options.auditPolicy);
  const sAttrs = new Map(source.attributes.map((a) => [a.logicalName, a]));
  const tAttrs = new Map(target.attributes.map((a) => [a.logicalName, a]));
  const out: PreparedRecord = {
    sourceId: record.id,
    name: null,
    values: {},
    deferred: {},
    principalFallbacks: [],
    impersonateUserId: null,
    auditWork: null,
    issues: [],
    blocked: null,
  };
  if (source.primaryNameAttribute) {
    const name = record.values[source.primaryNameAttribute];
    out.name = name === null || name === undefined ? null : String(name).slice(0, 200);
  }

  for (const m of entity.mappings) {
    const sAttr = sAttrs.get(m.sourceField);
    const tAttr = tAttrs.get(m.targetField);
    if (!sAttr || !tAttr) {
      out.blocked = {
        code: 'MAPPING_INVALID',
        reason: `Mapped column ${m.sourceField} → ${m.targetField} no longer exists in both environments`,
      };
      return out;
    }
    const raw = record.values[m.sourceField];
    if (LOOKUP_TYPES.has(tAttr.type)) {
      if (raw === null || raw === undefined) {
        out.values[tAttr.logicalName] = null;
        continue;
      }
      if (!isLookupValue(raw)) continue;
      if (m.deferredTargets?.includes(raw.logicalName)) {
        out.deferred[tAttr.logicalName] = raw;
        continue;
      }
      const key = lookupKey(raw.logicalName, raw.id);
      const resolved = input.lookups.get(key);
      if (resolved) {
        out.values[tAttr.logicalName] = { id: resolved, logicalName: raw.logicalName };
      } else if (input.pendingLookups?.has(key)) {
        // The referenced record is migrated earlier in the same run; nothing is blocked by it.
        out.issues.push({
          severity: 'WARNING',
          code: 'LOOKUP_PENDING_MIGRATION',
          field: m.sourceField,
          message: `Lookup ${m.sourceField} references ${raw.logicalName} ${raw.id}, which this migration creates before this record`,
          retryable: false,
        });
      } else if (isRequired(tAttr)) {
        out.blocked = {
          code: 'LOOKUP_UNRESOLVED',
          reason: `Required lookup ${m.sourceField} references ${raw.logicalName} ${raw.id}, which was not migrated and does not exist in the target`,
        };
        out.issues.push({
          severity: 'ERROR',
          code: 'LOOKUP_UNRESOLVED',
          field: m.sourceField,
          message: out.blocked.reason,
          retryable: true,
        });
        return out;
      } else {
        out.issues.push({
          severity: 'WARNING',
          code: 'LOOKUP_UNRESOLVED',
          field: m.sourceField,
          message: `Lookup ${m.sourceField} references ${raw.logicalName} ${raw.id}, which does not exist in the target; the value is left empty`,
          retryable: true,
        });
      }
      continue;
    }
    // Configured transformation, then choice mapping or type conversion. Cross-provider
    // conversions (truncation, overflow, invalid dates) are reported, never silently applied.
    const converted = transformField({
      value: raw ?? null,
      source: sAttr,
      target: tAttr,
      transform: m.transform,
      choiceMap: m.choiceMap,
    });
    if (!converted.ok) {
      out.blocked = { code: converted.code, reason: `${m.sourceField}: ${converted.error}` };
      out.issues.push({
        severity: 'ERROR',
        code: converted.code,
        field: m.sourceField,
        message: converted.error,
        retryable: false,
      });
      return out;
    }
    out.values[tAttr.logicalName] = converted.value;
  }

  // ----- ownership and audit attribution -------------------------------------
  const audit = entity.audit;
  const resolvePrincipal = (field: string | null, purpose: string): LookupValue | null => {
    if (!field) return null;
    const raw = record.values[field];
    if (!isLookupValue(raw)) return null;
    const mapped = input.principalMap.get(lookupKey(raw.logicalName, raw.id));
    if (mapped) return { id: mapped, logicalName: raw.logicalName };
    // No approved mapping: the policy decides, and the substitution is always reported.
    if (options.userResolutionPolicy === 'FALLBACK' && options.fallbackPrincipal) {
      out.principalFallbacks.push(field);
      out.issues.push({
        severity: 'WARNING',
        code: 'PRINCIPAL_FALLBACK_APPLIED',
        field,
        message: `${purpose} ${raw.logicalName} ${raw.id} has no approved mapping; the configured fallback identity ${options.fallbackPrincipal.name} is used instead`,
        retryable: false,
      });
      return { id: options.fallbackPrincipal.id, logicalName: options.fallbackPrincipal.logicalName };
    }
    out.blocked = {
      code: 'PRINCIPAL_UNRESOLVED',
      reason: `${purpose} ${raw.logicalName} ${raw.id} has no approved user mapping (user resolution policy: STRICT)`,
    };
    out.issues.push({
      severity: 'ERROR',
      code: 'PRINCIPAL_UNRESOLVED',
      field,
      message: out.blocked.reason,
      retryable: true,
    });
    return null;
  };

  if (flags.owner && audit.ownerField) {
    const owner = resolvePrincipal(audit.ownerField, 'Owner');
    if (out.blocked) return out;
    if (owner) out.values[audit.ownerField] = owner;
  }
  if (flags.createdOn && audit.createdOnField && audit.overriddenCreatedOnField) {
    const createdOn = record.values[audit.createdOnField];
    if (typeof createdOn === 'string') out.values[audit.overriddenCreatedOnField] = createdOn;
  }
  if (flags.createdBy && audit.createdByField) {
    const createdBy = resolvePrincipal(audit.createdByField, 'Created by');
    if (out.blocked) return out;
    if (createdBy) out.impersonateUserId = createdBy.id;
  }
  if (flags.modifiedBy && audit.modifiedByField && audit.touchField) {
    const modifiedBy = resolvePrincipal(audit.modifiedByField, 'Modified by');
    if (out.blocked) return out;
    if (modifiedBy && modifiedBy.id !== out.impersonateUserId) {
      out.auditWork = {
        modifiedById: modifiedBy.id,
        field: audit.touchField.target,
        value: out.values[audit.touchField.target] ?? null,
      };
    }
  }
  return out;
}

/**
 * Columns that must never take part in the change comparison: the platform owns them, and
 * including them would produce updates that change nothing.
 */
export function isComparableColumn(entity: PlannerEntity, field: string): boolean {
  if (field === entity.audit.overriddenCreatedOnField) return false; // create-only
  if (field === entity.audit.createdOnField) return false; // platform stamped
  if (field === 'createdby' || field === 'modifiedby' || field === 'modifiedon') return false;
  // ownerid is compared: assigning ownership is a real, intended change.
  if (field !== entity.audit.ownerField && SYSTEM_MANAGED_COLUMNS.has(field)) return false;
  return true;
}

/**
 * Fields whose canonical value differs between the prepared record and the target record.
 * Uses the same normalization as validation, so "identical" means identical to both features.
 */
export function computeChanges(
  entity: PlannerEntity,
  target: TableMetadata,
  values: Record<string, FieldValue>,
  current: DvRecord,
): FieldChangeDto[] {
  const tAttrs = new Map(target.attributes.map((a) => [a.logicalName, a]));
  const changes: FieldChangeDto[] = [];
  for (const [field, value] of Object.entries(values)) {
    const attr = tAttrs.get(field);
    if (!attr || !isComparableColumn(entity, field)) continue;
    const currentValue = current.values[field] ?? null;
    if (valuesEqual(attr, value, currentValue)) continue;
    changes.push({
      field,
      displayName: attr.displayName,
      sourceValue: displayValue(attr, value),
      targetValue: displayValue(attr, currentValue),
      action: value === null || value === undefined ? 'CLEAR' : 'SET',
    });
  }
  return changes.sort((a, b) => a.field.localeCompare(b.field));
}

export interface MatchResult {
  /** The single matching target record, when exactly one was found. */
  target: DvRecord | null;
  method: string | null;
  /** More than one target record matched: never guess. */
  conflict?: { code: string; reason: string };
}

export type PlannedAction =
  | { action: 'CREATE'; values: Record<string, FieldValue> }
  | {
      action: 'UPDATE';
      targetId: string;
      matchMethod: string | null;
      changes: FieldChangeDto[];
      values: Record<string, FieldValue>;
    }
  | { action: 'UNCHANGED'; targetId: string; matchMethod: string | null }
  | { action: 'SKIP'; targetId: string; matchMethod: string | null }
  | { action: 'CONFLICT'; code: string; reason: string; targetId?: string | null }
  | { action: 'BLOCKED'; code: string; reason: string };

/** Turns a prepared record plus its match into the action the engine will take. */
export function decideAction(
  entity: PlannerEntity,
  options: PlanOptions,
  target: TableMetadata,
  prepared: PreparedRecord,
  match: MatchResult,
): PlannedAction {
  if (prepared.blocked)
    return { action: 'BLOCKED', code: prepared.blocked.code, reason: prepared.blocked.reason };
  if (match.conflict) return { action: 'CONFLICT', code: match.conflict.code, reason: match.conflict.reason };
  if (!match.target) return { action: 'CREATE', values: prepared.values };

  const targetId = match.target.id;
  switch (options.conflictStrategy) {
    case 'SKIP_EXISTING':
      return { action: 'SKIP', targetId, matchMethod: match.method };
    case 'CREATE_ONLY':
      return {
        action: 'CONFLICT',
        code: 'ALREADY_EXISTS',
        reason: `A matching record already exists in the target (${match.method}); CREATE_ONLY does not modify existing records`,
        targetId,
      };
    case 'SYNC': {
      const changes = computeChanges(entity, target, prepared.values, match.target);
      if (changes.length === 0) return { action: 'UNCHANGED', targetId, matchMethod: match.method };
      const values: Record<string, FieldValue> = {};
      for (const c of changes) values[c.field] = prepared.values[c.field] ?? null;
      return { action: 'UPDATE', targetId, matchMethod: match.method, changes, values };
    }
    default: {
      // UPSERT: overwrite the mapped columns, but still report what changes.
      const changes = computeChanges(entity, target, prepared.values, match.target);
      const values = { ...prepared.values };
      delete values[entity.audit.overriddenCreatedOnField ?? ''];
      return { action: 'UPDATE', targetId, matchMethod: match.method, changes, values };
    }
  }
}

/** Maps an action to the classification shown in the preflight. */
export function classify(action: PlannedAction): PreflightAction {
  switch (action.action) {
    case 'CREATE':
      return 'CREATE';
    case 'UPDATE':
      return 'UPDATE';
    case 'UNCHANGED':
    case 'SKIP':
      return 'UNCHANGED';
    case 'CONFLICT':
      return 'CONFLICT';
    default:
      return 'BLOCKED';
  }
}
