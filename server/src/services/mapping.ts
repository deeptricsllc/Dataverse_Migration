import type { MappingStatus } from '../../../shared/domain';
import {
  LOOKUP_TYPES,
  SYSTEM_MANAGED_COLUMNS,
  type AttributeMeta,
  type AttributeType,
  type TableMetadata,
} from '../../../shared/metadata';
import { typeCompatibility } from './type-compat';

export interface MappingProposal {
  sourceField: string;
  sourceDisplayName: string;
  targetField: string | null;
  sourceType: AttributeType;
  targetType: AttributeType | null;
  status: MappingStatus;
  confidence: number;
  reason: string;
  isLookup: boolean;
  lookupTargets: string[];
  required: boolean;
}

const NON_DATA_TYPES: ReadonlySet<AttributeType> = new Set(['Virtual', 'EntityName', 'Image', 'File', 'Other']);
const STATE_COLUMNS = new Set(['statecode', 'statuscode']);

/** Source columns whose values a data migration can carry. */
export function isMigratableSourceColumn(table: TableMetadata, attr: AttributeMeta): boolean {
  if (attr.attributeOf) return false;
  if (attr.isPrimaryId || attr.logicalName === table.primaryIdAttribute) return false;
  if (NON_DATA_TYPES.has(attr.type)) return false;
  if (!attr.isValidForRead) return false;
  return attr.isValidForCreate || attr.isValidForUpdate;
}

export function isRequiredLevel(level: string | null | undefined): boolean {
  return level === 'ApplicationRequired' || level === 'SystemRequired';
}

/**
 * Deterministic auto-mapping: exact logical-name match + type compatibility + lookup target
 * compatibility. Never guesses; anything uncertain is left UNMAPPED for a human.
 */
export function autoMapTable(source: TableMetadata, target: TableMetadata | undefined): MappingProposal[] {
  const targetAttrs = new Map((target?.attributes ?? []).map((a) => [a.logicalName, a]));
  return source.attributes
    .filter((a) => isMigratableSourceColumn(source, a))
    .sort((a, b) => a.logicalName.localeCompare(b.logicalName))
    .map((s) => proposeMapping(s, targetAttrs.get(s.logicalName)));
}

export function proposeMapping(s: AttributeMeta, t: AttributeMeta | undefined): MappingProposal {
  const base = {
    sourceField: s.logicalName,
    sourceDisplayName: s.displayName,
    sourceType: s.type,
    isLookup: LOOKUP_TYPES.has(s.type),
    lookupTargets: s.targets ?? [],
  };
  if (SYSTEM_MANAGED_COLUMNS.has(s.logicalName)) {
    return {
      ...base,
      targetField: t?.logicalName ?? null,
      targetType: t?.type ?? null,
      status: 'IGNORED',
      confidence: 100,
      reason:
        s.logicalName === 'ownerid'
          ? 'Ownership is assigned by the target platform (defaults to the migrating user)'
          : 'System-managed column is maintained by Dataverse',
      required: false,
    };
  }
  if (STATE_COLUMNS.has(s.logicalName)) {
    return {
      ...base,
      targetField: t?.logicalName ?? null,
      targetType: t?.type ?? null,
      status: 'IGNORED',
      confidence: 100,
      reason: 'State transitions are not migrated in this version; records are created in their default state',
      required: false,
    };
  }
  if (!t) {
    return {
      ...base,
      targetField: null,
      targetType: null,
      status: 'UNMAPPED',
      confidence: 0,
      reason: 'No column with this logical name exists in the target',
      required: false,
    };
  }
  const required = isRequiredLevel(t.requiredLevel);
  if (!t.isValidForCreate && !t.isValidForUpdate) {
    return {
      ...base,
      targetField: t.logicalName,
      targetType: t.type,
      status: 'INCOMPATIBLE',
      confidence: 0,
      reason: 'Target column is read-only',
      required,
    };
  }
  const compat = typeCompatibility(s, t);
  if (!compat.compatible) {
    return {
      ...base,
      targetField: t.logicalName,
      targetType: t.type,
      status: 'INCOMPATIBLE',
      confidence: 0,
      reason: compat.note,
      required,
    };
  }
  return {
    ...base,
    targetField: t.logicalName,
    targetType: t.type,
    status: 'AUTO_MAPPED',
    confidence: compat.lossy ? 75 : 100,
    reason: compat.lossy
      ? `Exact logical-name match; ${compat.note ?? 'conversion may be lossy'}`
      : s.type === t.type
        ? 'Exact logical-name match with identical type'
        : 'Exact logical-name match with compatible type',
    required,
  };
}

/** Validates a user-chosen mapping. Returns an error message or null. */
export function validateManualMapping(source: AttributeMeta, target: AttributeMeta | undefined): string | null {
  if (!target) return 'Target column does not exist';
  if (!target.isValidForCreate && !target.isValidForUpdate) return 'Target column is read-only';
  const compat = typeCompatibility(source, target);
  if (!compat.compatible) return compat.note;
  return null;
}

// ---------------------------------------------------------------------------
// Mapping suggestion abstraction (AI-ready)
// ---------------------------------------------------------------------------

export interface MappingSuggestion {
  sourceField: string;
  targetField: string;
  confidence: number;
  rationale: string;
  provider: string;
}

export interface MappingSuggestionContext {
  source: TableMetadata;
  target: TableMetadata;
  /** Source columns currently without a mapping. */
  unmapped: AttributeMeta[];
  /** Target columns already used by other mappings. */
  usedTargets: ReadonlySet<string>;
}

/**
 * Providers only produce suggestions. Suggestions are never applied automatically: the user
 * must accept each one, which records a MANUAL mapping. An LLM-backed provider can implement
 * this interface later; the deterministic engine never depends on it.
 */
export interface MappingSuggestionProvider {
  readonly id: string;
  readonly description: string;
  suggest(ctx: MappingSuggestionContext): Promise<MappingSuggestion[]>;
}

const stripPrefix = (name: string) => name.replace(/^[a-z0-9]+_/, '');
const tokens = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function levenshteinRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
}

export function nameSimilarity(a: AttributeMeta, b: AttributeMeta): number {
  const ln = levenshteinRatio(stripPrefix(a.logicalName), stripPrefix(b.logicalName));
  const ta = new Set(tokens(a.displayName));
  const tb = new Set(tokens(b.displayName));
  const inter = [...ta].filter((x) => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size || 1;
  return Math.max(ln, inter / union);
}

/** Local, deterministic similarity provider (no external calls). */
export class NameSimilaritySuggestionProvider implements MappingSuggestionProvider {
  readonly id = 'name-similarity';
  readonly description = 'Similar logical/display names with compatible types';

  async suggest(ctx: MappingSuggestionContext): Promise<MappingSuggestion[]> {
    const suggestions: MappingSuggestion[] = [];
    const candidates = ctx.target.attributes.filter(
      (t) =>
        !t.attributeOf &&
        !t.isPrimaryId &&
        (t.isValidForCreate || t.isValidForUpdate) &&
        !ctx.usedTargets.has(t.logicalName) &&
        !SYSTEM_MANAGED_COLUMNS.has(t.logicalName),
    );
    for (const s of ctx.unmapped) {
      let best: { t: AttributeMeta; score: number } | null = null;
      for (const t of candidates) {
        if (!typeCompatibility(s, t).compatible) continue;
        const score = nameSimilarity(s, t);
        if (score >= 0.6 && (!best || score > best.score)) best = { t, score };
      }
      if (best) {
        suggestions.push({
          sourceField: s.logicalName,
          targetField: best.t.logicalName,
          confidence: Math.round(best.score * 100),
          rationale: `Name similarity ${Math.round(best.score * 100)}% ("${s.displayName}" ~ "${best.t.displayName}") and compatible type ${s.type} → ${best.t.type}`,
          provider: this.id,
        });
      }
    }
    return suggestions;
  }
}
