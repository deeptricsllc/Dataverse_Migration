/**
 * Data profiling and data-quality rule evaluation.
 *
 * Profiling answers "what is actually in this column" before a migration runs, so a person can
 * see the 38 records that will be rejected instead of discovering them in an error log.
 *
 * Three properties matter more than the statistics themselves:
 *
 *  1. It is strictly READ-ONLY. Only `countRecords`, `getTable` and `queryRecords` are used, so
 *     it behaves identically when REAL_TENANT_READ_ONLY blocks every write.
 *  2. It never loads a table into memory. Records are streamed page by page and folded into
 *     fixed-size accumulators; every Set/Map kept here has an explicit cap.
 *  3. It never presents a sampled number as an exact one. Each profile and each issue carries a
 *     {@link StatisticBasis}, and EXACT is claimed only when every record was examined.
 *
 * It is provider-neutral: it talks to {@link MigrationConnector} and the normalized metadata
 * model only, so Dataverse, SQL Server and Azure SQL are profiled by the same code.
 */
import type { Logger } from 'pino';
import type {
  DataQualityIssueDto,
  DataQualityRuleDto,
  FieldProfileDto,
  StatisticBasis,
  TableProfileDto,
  ValueFrequencyDto,
} from '../../../shared/domain';
import {
  isLookupValue,
  LOOKUP_TYPES,
  SYSTEM_MANAGED_COLUMNS,
  type AttributeMeta,
  type AttributeType,
  type FieldValue,
  type TableMetadata,
} from '../../../shared/metadata';
import type { MigrationConnector } from '../connectors/types';
import type { ConnectionFactory } from '../dataverse/factory';
import type { AppDb } from '../db/client';
import { badRequest, notFound } from '../lib/errors';
import type { RequestContext } from './context';
import { integrationError, type EnvironmentService } from './environment-service';
import type { MetadataService } from './metadata-service';

// --- caps and defaults -------------------------------------------------------
// Every one of these exists to bound memory or run time. They are exported so tests and the UI
// can state the same numbers the engine uses instead of repeating them.

/** Page size requested from the connector. Records are consumed page by page, never collected. */
export const PROFILE_PAGE_SIZE = 500;
/** Records examined when the caller does not ask for something else. */
export const DEFAULT_SAMPLE_SIZE = 10_000;
/** Ceiling for an explicit `sampleSize`. */
export const MAX_SAMPLE_SIZE = 200_000;
/** A `full` profile is only honoured up to this many records; beyond it profiling samples. */
export const FULL_PROFILE_LIMIT = 200_000;
/**
 * Distinct values tracked per column. A high-cardinality column (every GUID, every timestamp)
 * would otherwise grow one map entry per record, which is exactly the unbounded memory this
 * service promises not to use. When the cap is reached the distinct/duplicate counts become
 * null — an unknown answer, never a wrong one.
 */
export const DISTINCT_VALUE_CAP = 50_000;
/** Most frequent values returned per column (for choice mapping). */
export const TOP_VALUES_LIMIT = 50;
/** Offending values kept per issue, so a person can recognise the problem. */
export const MAX_ISSUE_SAMPLES = 5;
/** Columns profiled in one pass, so a pathologically wide table cannot stall a request. */
export const MAX_PROFILED_COLUMNS = 300;
/** Longest REGEX_PATTERN accepted. A rule is declarative data; it must not become a stall. */
export const MAX_REGEX_LENGTH = 200;

/** What a secured column's values are replaced with. Counts are kept; the value never leaves. */
export const MASKED_VALUE = '***';

const NUMERIC_TYPES: ReadonlySet<AttributeType> = new Set<AttributeType>([
  'Integer',
  'BigInt',
  'Decimal',
  'Double',
  'Money',
  'Picklist',
  'State',
  'Status',
]);

const TEXT_TYPES: ReadonlySet<AttributeType> = new Set<AttributeType>([
  'String',
  'Memo',
  'EntityName',
  'Uniqueidentifier',
  'Other',
]);

/** Types whose values cannot be read as data by a profile (binary, computed, navigation). */
const UNPROFILABLE_TYPES: ReadonlySet<AttributeType> = new Set<AttributeType>(['Image', 'File', 'Virtual']);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^[+0-9][0-9\s().\-/]{4,}$/;
const GUID_PATTERN = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** The single string form a value is counted, compared and measured by. */
function canonicalText(value: Exclude<FieldValue, null>): string {
  if (isLookupValue(value)) return value.id; // a lookup profiles by its id, not its label
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

function toNumber(value: Exclude<FieldValue, null>): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || isLookupValue(value) || Array.isArray(value)) return null;
  const text = value.trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

// --- rules -------------------------------------------------------------------

/** One rule's exact tally within what was examined, plus a few offending values. */
export interface RuleViolation {
  count: number;
  samples: { recordId: string; value: string | null }[];
}

/**
 * Per-rule violation counts produced while streaming, keyed by {@link ruleKey}.
 *
 * Summary statistics cannot answer "how many values are longer than 160 characters" — only
 * "the longest is 204". So the rules are handed to profiling, counted per record as the data
 * goes past, and handed back to {@link evaluateRules}, which is what makes the number real.
 */
export type RuleViolations = Map<string, RuleViolation>;

/** Stable identity of a rule, so a count recorded while streaming is found again afterwards. */
export function ruleKey(rule: DataQualityRuleDto): string {
  return [
    rule.kind,
    rule.field,
    rule.min ?? '',
    rule.max ?? '',
    rule.pattern ?? '',
    JSON.stringify(rule.values ?? []),
  ].join('|');
}

/** Compiles a REGEX_PATTERN rule. Returns null for anything unsafe or malformed. */
function compilePattern(pattern: string | null | undefined): RegExp | null {
  if (!pattern || pattern.length > MAX_REGEX_LENGTH) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

const isRequiredLevel = (a: AttributeMeta) =>
  a.requiredLevel === 'ApplicationRequired' || a.requiredLevel === 'SystemRequired';

/**
 * Turns the TARGET column definitions into rules stated against the SOURCE fields, so profiling
 * the source answers "will this data be accepted over there" rather than "is this data tidy".
 */
export function deriveTargetRules(
  target: TableMetadata,
  mappings: { sourceField: string; targetField: string }[],
): DataQualityRuleDto[] {
  const byName = new Map(target.attributes.map((a) => [a.logicalName, a]));
  const rules: DataQualityRuleDto[] = [];
  for (const m of mappings) {
    const attr = m.targetField ? byName.get(m.targetField) : undefined;
    if (!attr) continue;
    if (isRequiredLevel(attr)) {
      rules.push({ kind: 'REQUIRED', field: m.sourceField, origin: 'TARGET_SCHEMA', severity: 'BLOCKER' });
    }
    if ((attr.type === 'String' || attr.type === 'Memo') && attr.maxLength != null && attr.maxLength > 0) {
      rules.push({
        kind: 'MAX_LENGTH',
        field: m.sourceField,
        max: attr.maxLength,
        origin: 'TARGET_SCHEMA',
        severity: 'BLOCKER',
      });
    }
    if (attr.minValue != null || attr.maxValue != null) {
      rules.push({
        kind: 'NUMERIC_RANGE',
        field: m.sourceField,
        min: attr.minValue ?? null,
        max: attr.maxValue ?? null,
        origin: 'TARGET_SCHEMA',
        severity: 'BLOCKER',
      });
    }
    if (attr.format === 'Email') {
      rules.push({
        kind: 'VALID_EMAIL',
        field: m.sourceField,
        origin: 'TARGET_SCHEMA',
        severity: 'WARNING',
      });
    }
  }
  return rules;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Turns statistics into findings. Pure: the same profile and rules always produce the same
 * issues. `violations` carries the exact per-record tallies gathered while streaming; without
 * it only the findings that summary statistics can prove are reported, and the message says so.
 */
export function evaluateRules(
  profile: FieldProfileDto,
  rules: DataQualityRuleDto[],
  violations?: RuleViolations,
): DataQualityIssueDto[] {
  const issues: DataQualityIssueDto[] = [];
  const scope = profile.basis === 'EXACT' ? 'record' : 'examined record';
  const add = (
    code: string,
    severity: 'BLOCKER' | 'WARNING',
    affected: number,
    message: string,
    resolution: string,
    samples?: { recordId: string; value: string | null }[],
  ) => {
    issues.push({
      severity,
      code,
      field: profile.field,
      message,
      affected,
      // Always the profile's basis: a count taken from a sample must never read as a total.
      basis: profile.basis,
      resolution,
      ...(samples && samples.length ? { samples } : {}),
    });
  };

  for (const rule of rules) {
    if (rule.field !== profile.field) continue;
    const hit = violations?.get(ruleKey(rule));
    const samples = hit?.samples;
    switch (rule.kind) {
      case 'REQUIRED': {
        const affected = profile.nullCount + profile.blankCount;
        if (affected > 0) {
          add(
            'REQUIRED_VALUE_MISSING',
            rule.severity,
            affected,
            `${affected} ${plural(affected, scope, `${scope}s`)} have no value for ${profile.field}, which the target requires.`,
            'Supply a value in the source, map a default through a DEFAULT_IF_NULL transformation, or exclude these records.',
            samples,
          );
        }
        break;
      }
      case 'NOT_BLANK': {
        if (profile.blankCount > 0) {
          add(
            'BLANK_VALUE',
            rule.severity,
            profile.blankCount,
            `${profile.blankCount} ${plural(profile.blankCount, scope, `${scope}s`)} hold a blank ${profile.field}.`,
            'Trim and convert blanks to null with an EMPTY_TO_NULL transformation, or supply a value.',
            samples,
          );
        }
        break;
      }
      case 'MAX_LENGTH': {
        const max = Number(rule.max);
        if (!Number.isFinite(max)) break;
        if (hit) {
          if (hit.count > 0) {
            add(
              'STRING_TOO_LONG',
              rule.severity,
              hit.count,
              `${hit.count} ${plural(hit.count, scope, `${scope}s`)} exceed the target limit of ${max} characters (longest ${profile.maxLength ?? 0}).`,
              `Shorten the source values or add a TRUNCATE transformation to ${max} characters, accepting the loss.`,
              samples,
            );
          }
        } else if (profile.maxLength != null && profile.maxLength > max) {
          // Without per-record counting only the longest value is known, so say exactly that.
          add(
            'STRING_TOO_LONG',
            rule.severity,
            0,
            `At least one value exceeds the target limit of ${max} characters (longest ${profile.maxLength}); the exact number was not counted.`,
            `Re-run profiling with this rule to count the affected records, or add a TRUNCATE transformation to ${max} characters.`,
          );
        }
        break;
      }
      case 'MIN_LENGTH': {
        if (hit && hit.count > 0) {
          add(
            'STRING_TOO_SHORT',
            rule.severity,
            hit.count,
            `${hit.count} ${plural(hit.count, scope, `${scope}s`)} are shorter than the required ${rule.min} characters.`,
            'Correct the source values or exclude these records from the migration.',
            samples,
          );
        }
        break;
      }
      case 'VALID_EMAIL': {
        if (hit && hit.count > 0) {
          add(
            'INVALID_EMAIL',
            rule.severity,
            hit.count,
            `${hit.count} ${plural(hit.count, scope, `${scope}s`)} hold a value that is not a valid email address.`,
            'Correct the addresses in the source, or clear them so the target column stays empty.',
            samples,
          );
        }
        break;
      }
      case 'VALID_PHONE': {
        if (hit && hit.count > 0) {
          add(
            'INVALID_PHONE',
            rule.severity,
            hit.count,
            `${hit.count} ${plural(hit.count, scope, `${scope}s`)} hold a value that is not a recognisable phone number.`,
            'Normalise the numbers in the source before migrating.',
            samples,
          );
        }
        break;
      }
      case 'NUMERIC_RANGE': {
        if (hit && hit.count > 0) {
          add(
            'VALUE_OUT_OF_RANGE',
            rule.severity,
            hit.count,
            `${hit.count} ${plural(hit.count, scope, `${scope}s`)} fall outside the target range ${rule.min ?? '-∞'} to ${rule.max ?? '∞'}.`,
            'Correct the values in the source; the target column will reject them.',
            samples,
          );
        }
        break;
      }
      case 'DATE_RANGE': {
        if (hit && hit.count > 0) {
          add(
            'DATE_OUT_OF_RANGE',
            rule.severity,
            hit.count,
            `${hit.count} ${plural(hit.count, scope, `${scope}s`)} fall outside the accepted date range.`,
            'Correct the dates in the source or exclude these records.',
            samples,
          );
        }
        break;
      }
      case 'ALLOWED_VALUES': {
        if (hit && hit.count > 0) {
          add(
            'VALUE_NOT_ALLOWED',
            rule.severity,
            hit.count,
            `${hit.count} ${plural(hit.count, scope, `${scope}s`)} hold a value the target does not accept.`,
            'Map the unexpected values to target values, or set a default for unmapped values.',
            samples,
          );
        }
        break;
      }
      case 'REGEX_PATTERN': {
        if (hit && hit.count > 0) {
          add(
            'PATTERN_MISMATCH',
            rule.severity,
            hit.count,
            `${hit.count} ${plural(hit.count, scope, `${scope}s`)} do not match the required pattern.`,
            'Correct the source values so they match the expected format.',
            samples,
          );
        }
        break;
      }
      case 'UNIQUE': {
        // A null duplicate count means the distinct cap was hit: unknown, so nothing is claimed.
        if (profile.duplicateCount != null && profile.duplicateCount > 0) {
          add(
            'DUPLICATE_KEY',
            rule.severity,
            profile.duplicateCount,
            `${profile.duplicateCount} ${plural(profile.duplicateCount, scope, `${scope}s`)} repeat a value that must be unique in the target.`,
            'De-duplicate the source, or choose a different match key for this table.',
            samples,
          );
        }
        break;
      }
    }
  }
  return issues;
}

// --- accumulation ------------------------------------------------------------

/**
 * Fixed-size statistics for one column. Every record is folded in as it streams past; nothing
 * beyond the capped frequency map is retained, so memory does not grow with the table.
 */
class FieldAccumulator {
  private examined = 0;
  private nonNull = 0;
  private nullCount = 0;
  private blankCount = 0;
  private whitespaceCount = 0;
  private invalidValueCount = 0;
  private invalidDateCount = 0;
  private minLength: number | null = null;
  private maxLength: number | null = null;
  private lengthSum = 0;
  private lengthCount = 0;
  private minValue: number | null = null;
  private maxValue: number | null = null;
  private valueSum = 0;
  private valueCount = 0;
  private maxScale: number | null = null;
  private minDate: number | null = null;
  private maxDate: number | null = null;
  /** value -> occurrences, capped at DISTINCT_VALUE_CAP entries. */
  private readonly freq = new Map<string, number>();
  private distinctOverflow = false;
  private readonly violations: RuleViolations = new Map();
  private readonly patterns = new Map<string, RegExp | null>();

  private readonly isText: boolean;
  private readonly isNumeric: boolean;
  private readonly isDate: boolean;
  private readonly isLookup: boolean;

  constructor(
    private readonly attr: AttributeMeta,
    private readonly rules: DataQualityRuleDto[],
    private readonly targetField: string | null,
  ) {
    this.isLookup = LOOKUP_TYPES.has(attr.type);
    this.isText = TEXT_TYPES.has(attr.type) || this.isLookup;
    this.isNumeric = NUMERIC_TYPES.has(attr.type);
    this.isDate = attr.type === 'DateTime';
    for (const rule of rules) {
      if (rule.kind === 'REGEX_PATTERN') this.patterns.set(ruleKey(rule), compilePattern(rule.pattern));
    }
  }

  add(raw: FieldValue | undefined, recordId: string): void {
    this.examined++;
    if (raw === null || raw === undefined) {
      this.nullCount++;
      this.checkRules(null, recordId);
      return;
    }
    const text = canonicalText(raw);
    const trimmed = text.trim();
    this.nonNull++;

    if (typeof raw === 'string') {
      if (trimmed === '') this.blankCount++;
      else if (text !== trimmed) this.whitespaceCount++; // leading or trailing whitespace
    }

    // Distinct tracking. Once the cap is reached existing values keep counting (so topValues
    // stay useful) but no new value is admitted, and the distinct count is reported as unknown.
    const seen = this.freq.get(text);
    if (seen !== undefined) this.freq.set(text, seen + 1);
    else if (this.freq.size >= DISTINCT_VALUE_CAP) this.distinctOverflow = true;
    else this.freq.set(text, 1);

    if (this.isText) {
      const len = text.length;
      this.minLength = this.minLength === null ? len : Math.min(this.minLength, len);
      this.maxLength = this.maxLength === null ? len : Math.max(this.maxLength, len);
      this.lengthSum += len;
      this.lengthCount++;
    }

    if (this.isNumeric) {
      const n = toNumber(raw);
      if (n === null) {
        if (trimmed !== '') this.invalidValueCount++;
      } else {
        this.minValue = this.minValue === null ? n : Math.min(this.minValue, n);
        this.maxValue = this.maxValue === null ? n : Math.max(this.maxValue, n);
        this.valueSum += n;
        this.valueCount++;
        const scale = decimalScale(text);
        if (scale !== null) this.maxScale = this.maxScale === null ? scale : Math.max(this.maxScale, scale);
      }
    }

    if (this.isDate) {
      const ms = trimmed === '' ? Number.NaN : Date.parse(trimmed);
      if (Number.isNaN(ms)) {
        if (trimmed !== '') {
          this.invalidDateCount++;
          this.invalidValueCount++;
        }
      } else {
        this.minDate = this.minDate === null ? ms : Math.min(this.minDate, ms);
        this.maxDate = this.maxDate === null ? ms : Math.max(this.maxDate, ms);
      }
    }

    if (this.attr.type === 'Boolean' && typeof raw !== 'boolean') {
      if (!['true', 'false', '0', '1', 'yes', 'no'].includes(trimmed.toLowerCase())) this.invalidValueCount++;
    }
    if (this.isLookup && !isLookupValue(raw) && typeof raw !== 'string') this.invalidValueCount++;
    if (this.attr.type === 'Uniqueidentifier' && trimmed !== '' && !GUID_PATTERN.test(trimmed)) {
      this.invalidValueCount++;
    }

    this.checkRules(text, recordId);
  }

  /** Evaluates the supplied rules against this one value, so the counts are exact, not inferred. */
  private checkRules(text: string | null, recordId: string): void {
    if (this.rules.length === 0) return;
    const trimmed = text === null ? null : text.trim();
    const blank = trimmed === null || trimmed === '';
    for (const rule of this.rules) {
      let failed = false;
      switch (rule.kind) {
        case 'REQUIRED':
          failed = blank;
          break;
        case 'NOT_BLANK':
          failed = text !== null && trimmed === '';
          break;
        case 'MAX_LENGTH': {
          const max = Number(rule.max);
          failed = text !== null && Number.isFinite(max) && text.length > max;
          break;
        }
        case 'MIN_LENGTH': {
          const min = Number(rule.min);
          failed = !blank && Number.isFinite(min) && (text as string).length < min;
          break;
        }
        case 'VALID_EMAIL':
          failed = !blank && !EMAIL_PATTERN.test(trimmed as string);
          break;
        case 'VALID_PHONE':
          failed = !blank && !PHONE_PATTERN.test(trimmed as string);
          break;
        case 'NUMERIC_RANGE': {
          if (blank) break;
          const n = Number(trimmed);
          if (!Number.isFinite(n)) break; // counted as an invalid value, not as out of range
          const min = rule.min == null ? null : Number(rule.min);
          const max = rule.max == null ? null : Number(rule.max);
          failed = (min !== null && n < min) || (max !== null && n > max);
          break;
        }
        case 'DATE_RANGE': {
          if (blank) break;
          const ms = Date.parse(trimmed as string);
          if (Number.isNaN(ms)) break;
          const min = rule.min == null ? Number.NaN : Date.parse(String(rule.min));
          const max = rule.max == null ? Number.NaN : Date.parse(String(rule.max));
          failed = (!Number.isNaN(min) && ms < min) || (!Number.isNaN(max) && ms > max);
          break;
        }
        case 'ALLOWED_VALUES':
          failed = !blank && !(rule.values ?? []).includes(trimmed as string);
          break;
        case 'REGEX_PATTERN': {
          const re = this.patterns.get(ruleKey(rule));
          failed = !blank && re != null && !re.test(trimmed as string);
          break;
        }
        case 'UNIQUE':
          break; // decided from the distinct/duplicate counts, not per record
      }
      if (failed) this.record(rule, recordId, text);
    }
  }

  private record(rule: DataQualityRuleDto, recordId: string, value: string | null): void {
    const key = ruleKey(rule);
    let hit = this.violations.get(key);
    if (!hit) {
      hit = { count: 0, samples: [] };
      this.violations.set(key, hit);
    }
    hit.count++;
    if (hit.samples.length < MAX_ISSUE_SAMPLES) {
      hit.samples.push({ recordId, value: this.mask(value) });
    }
  }

  /** Field-level security: the statistics are safe to publish, the values are not. */
  private mask(value: string | null): string | null {
    if (value === null) return null;
    return this.attr.isSecured ? MASKED_VALUE : value;
  }

  get ruleViolations(): RuleViolations {
    return this.violations;
  }

  toDto(basis: StatisticBasis): FieldProfileDto {
    const distinctCount = this.distinctOverflow ? null : this.freq.size;
    const topValues: ValueFrequencyDto[] = [...this.freq.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, TOP_VALUES_LIMIT)
      .map(([value, count]) => ({ value: this.mask(value), count }));
    return {
      field: this.attr.logicalName,
      displayName: this.attr.displayName,
      type: this.attr.type,
      targetField: this.targetField,
      basis,
      examined: this.examined,
      nullCount: this.nullCount,
      nullPercent: this.examined ? round((this.nullCount / this.examined) * 100, 1) : 0,
      blankCount: this.blankCount,
      distinctCount,
      duplicateCount: distinctCount === null ? null : this.nonNull - distinctCount,
      minLength: this.minLength,
      maxLength: this.maxLength,
      averageLength: this.lengthCount ? round(this.lengthSum / this.lengthCount, 1) : null,
      whitespaceCount: this.whitespaceCount,
      minValue: this.minValue,
      maxValue: this.maxValue,
      averageValue: this.valueCount ? round(this.valueSum / this.valueCount, 6) : null,
      maxScale: this.maxScale,
      minDate: this.minDate === null ? null : new Date(this.minDate).toISOString(),
      maxDate: this.maxDate === null ? null : new Date(this.maxDate).toISOString(),
      invalidDateCount: this.invalidDateCount,
      invalidValueCount: this.invalidValueCount,
      topValues,
      topValuesTruncated: this.distinctOverflow || this.freq.size > TOP_VALUES_LIMIT,
      issues: [],
    };
  }
}

/** Decimal places in a numeric literal. Null when the form gives no honest answer (1e-7). */
function decimalScale(text: string): number | null {
  const t = text.trim();
  if (/[eE]/.test(t)) return null;
  const dot = t.indexOf('.');
  return dot < 0 ? 0 : t.length - dot - 1;
}

export interface ProfileTableInput {
  environmentId: string;
  table: string;
  /** Profile only these columns. Also the only way to profile a system-managed column. */
  fields?: string[];
  sampleSize?: number;
  /** Examine every record, honoured only up to {@link FULL_PROFILE_LIMIT}. */
  full?: boolean;
  /** Rules counted per record while streaming, so the reported counts are exact. */
  rules?: DataQualityRuleDto[];
  /** Target columns, only so a profile can name the column each field feeds. */
  mappings?: { sourceField: string; targetField: string }[];
}

export interface ProfileFieldInput {
  environmentId: string;
  table: string;
  field: string;
  sampleSize?: number;
  rules?: DataQualityRuleDto[];
}

/** Read-only profiling of a table or a single column. Never writes, never buffers a table. */
export class ProfilingService {
  constructor(
    private readonly db: AppDb,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly logger: Logger,
  ) {}

  async profileTable(ctx: RequestContext, input: ProfileTableInput): Promise<TableProfileDto> {
    const env = await this.environmentsSvc.getAccessible(ctx, input.environmentId);
    const conn = await this.connections.connectorFor(env, ctx.userId, { requestId: ctx.requestId });
    try {
      const meta = await this.metadata.getTable(env.id, conn, input.table);
      if (!meta) throw notFound('Table');
      return await this.run(ctx, env.id, conn, meta, input);
    } catch (err) {
      throw integrationError(err, 'Profiling');
    }
  }

  /**
   * One column. Delegates to the same accumulator as {@link profileTable} so there is exactly
   * one implementation of every statistic.
   */
  async profileField(ctx: RequestContext, input: ProfileFieldInput): Promise<FieldProfileDto> {
    const profile = await this.profileTable(ctx, {
      environmentId: input.environmentId,
      table: input.table,
      fields: [input.field],
      sampleSize: input.sampleSize,
      rules: input.rules,
    });
    const field = profile.fields.find((f) => f.field === input.field);
    if (!field) throw notFound('Column');
    return field;
  }

  /** The streaming pass. Extracted so the connector, metadata and environment lookups stay above. */
  private async run(
    ctx: RequestContext,
    environmentId: string,
    conn: MigrationConnector,
    meta: TableMetadata,
    input: ProfileTableInput,
  ): Promise<TableProfileDto> {
    const started = Date.now();
    const requested = new Set((input.fields ?? []).filter((f) => f.trim() !== ''));
    const columns = selectColumns(meta, requested);
    if (columns.length === 0) throw badRequest('No readable columns to profile for this table');

    const total = await conn.countRecords(meta);
    const limit = resolveLimit(input, total.count, total.approximate);

    const pk = meta.primaryIdAttribute;
    const rulesByField = new Map<string, DataQualityRuleDto[]>();
    for (const rule of input.rules ?? []) {
      const list = rulesByField.get(rule.field);
      if (list) list.push(rule);
      else rulesByField.set(rule.field, [rule]);
    }
    const targets = new Map((input.mappings ?? []).map((m) => [m.sourceField, m.targetField]));
    const accumulators = columns.map(
      (c) =>
        new FieldAccumulator(c, rulesByField.get(c.logicalName) ?? [], targets.get(c.logicalName) ?? null),
    );

    // The primary key is always read so key integrity can be reported even when it is not profiled.
    const columnNames = [...new Set([pk, ...columns.map((c) => c.logicalName)])];
    const keysSeen = new Set<string>();
    let keyOverflow = false;
    let primaryKeyMissing = 0;
    let duplicateKeyCount = 0;
    let examined = 0;

    outer: for await (const page of conn.queryRecords(meta, columnNames, { pageSize: PROFILE_PAGE_SIZE })) {
      for (const record of page) {
        if (examined >= limit) break outer;
        examined++;
        for (let i = 0; i < columns.length; i++) {
          accumulators[i].add(record.values[columns[i].logicalName], record.id);
        }
        const keyValue = record.values[pk];
        const key = keyValue === null || keyValue === undefined ? record.id : canonicalText(keyValue);
        if (key.trim() === '') primaryKeyMissing++;
        else if (keysSeen.has(key)) duplicateKeyCount++;
        else if (keysSeen.size >= DISTINCT_VALUE_CAP)
          keyOverflow = true; // stop growing; duplicates beyond the cap go unreported
        else keysSeen.add(key);
      }
      if (examined >= limit) break;
    }

    // EXACT is claimed only when every record was seen AND the count itself was exact. An
    // approximate total (large Dataverse tables report a snapshot) can never prove completeness.
    const basis: StatisticBasis = !total.approximate && examined >= total.count ? 'EXACT' : 'SAMPLED';

    const fields = accumulators.map((acc) => {
      const dto = acc.toDto(basis);
      dto.issues = evaluateRules(dto, rulesByField.get(dto.field) ?? [], acc.ruleViolations);
      return dto;
    });

    const issues: DataQualityIssueDto[] = [];
    if (primaryKeyMissing > 0) {
      issues.push({
        severity: 'BLOCKER',
        code: 'PRIMARY_KEY_MISSING',
        field: pk,
        message: `${primaryKeyMissing} of ${examined} examined records have no primary key value.`,
        affected: primaryKeyMissing,
        basis,
        resolution: 'Records without a key cannot be matched or re-run safely. Fix the source data.',
      });
    }
    if (duplicateKeyCount > 0) {
      issues.push({
        severity: 'WARNING',
        code: 'DUPLICATE_KEY',
        field: pk,
        message: `${duplicateKeyCount} examined records repeat a primary key value already seen.`,
        affected: duplicateKeyCount,
        basis,
        resolution: 'De-duplicate the source or choose a different match key for this table.',
      });
    }

    const durationMs = Date.now() - started;
    this.logger.info(
      {
        requestId: ctx.requestId,
        environmentId,
        table: meta.logicalName,
        columns: columns.length,
        examined,
        total: total.count,
        basis,
        fullRequested: input.full === true,
        keyOverflow,
        ms: durationMs,
      },
      'Table profiled',
    );

    return {
      environmentId,
      table: meta.logicalName,
      displayName: meta.displayName,
      basis,
      totalRecords: total.count,
      totalApproximate: total.approximate,
      examined,
      columns: columns.length,
      primaryKeyField: pk,
      primaryKeyMissing,
      duplicateKeyCount,
      fields,
      issues,
      profiledAt: new Date().toISOString(),
      durationMs,
    };
  }
}

/** Columns worth profiling: readable, meaningful, and not platform noise unless asked for. */
function selectColumns(meta: TableMetadata, requested: ReadonlySet<string>): AttributeMeta[] {
  const explicit = requested.size > 0;
  return meta.attributes
    .filter((a) => {
      if (!a.isValidForRead) return false;
      if (explicit) return requested.has(a.logicalName);
      if (SYSTEM_MANAGED_COLUMNS.has(a.logicalName)) return false;
      if (UNPROFILABLE_TYPES.has(a.type)) return false;
      if (a.attributeOf) return false; // computed child of another column (a lookup's name)
      return true;
    })
    .slice(0, MAX_PROFILED_COLUMNS);
}

/**
 * How many records will be read. A `full` profile is honoured only when the table is small
 * enough and the total is exact; otherwise profiling falls back to sampling, which the returned
 * basis (SAMPLED) reports honestly rather than silently pretending the profile is complete.
 */
function resolveLimit(input: ProfileTableInput, total: number, approximate: boolean): number {
  if (input.sampleSize !== undefined && (!Number.isFinite(input.sampleSize) || input.sampleSize < 1)) {
    throw badRequest('sampleSize must be a positive number');
  }
  if (input.full && !approximate && total <= FULL_PROFILE_LIMIT) return Math.max(total, 1);
  const requested = input.sampleSize === undefined ? DEFAULT_SAMPLE_SIZE : Math.floor(input.sampleSize);
  return Math.min(requested, MAX_SAMPLE_SIZE);
}
