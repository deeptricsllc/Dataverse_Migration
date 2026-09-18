/**
 * The transformation engine: the one place a source value becomes a target value.
 *
 * Preview, preflight, migration execution and validation all call this module. That is the whole
 * point of it: if the preview says `" ACTIVE "` becomes `100000000`, then preflight classifies
 * against `100000000`, the migration writes `100000000`, and validation compares `100000000`. A
 * second implementation anywhere would let those four disagree, which is exactly the class of bug
 * that makes a migration tool untrustworthy.
 *
 * Rules are declarative data, never code. There is no expression language, no scripting, no SQL;
 * a rule can only select from the closed list in `TRANSFORMATION_KINDS`, so transformation
 * configuration can never become an injection mechanism.
 *
 * Every function here is pure and deterministic: same value, same rules, same context, same
 * result — no clock, no randomness, no I/O.
 */
import {
  isLossyRule,
  type AppliedTransformationDto,
  type ChoiceMappingDto,
  type FieldTransformDto,
  type TransformationCondition,
  type TransformationIssueDto,
  type TransformationRule,
} from '../../../../shared/domain';
import {
  isLookupValue,
  type AttributeMeta,
  type DvRecord,
  type FieldValue,
} from '../../../../shared/metadata';
import { convertValue } from '../../connectors/sql/type-map';
import { transformValue } from '../values';

export interface TransformContext {
  /** The whole source record, so CONCAT and conditional rules can read other columns. */
  record?: Pick<DvRecord, 'values'> | null;
  /** Source column metadata by logical name, for formatting other columns in CONCAT. */
  sourceAttributes?: ReadonlyMap<string, AttributeMeta>;
}

export interface TransformFieldInput {
  value: FieldValue;
  source: AttributeMeta;
  target: AttributeMeta;
  /** Ordered pipeline. Runs before type conversion and before the choice map. */
  rules?: TransformationRule[] | null;
  /** Legacy single-step transformation, from plans that predate pipelines. */
  legacyTransform?: FieldTransformDto | null;
  /** Value mapping for a choice column, applied as the final mapping step. */
  choiceMap?: ChoiceMappingDto | null;
  context?: TransformContext;
}

export interface TransformFieldResult {
  ok: boolean;
  /** The value the target will receive. Meaningless when `ok` is false. */
  value: FieldValue;
  originalValue: FieldValue;
  applied: AppliedTransformationDto[];
  issues: TransformationIssueDto[];
  /** True when at least one applied rule discarded information. */
  lossy: boolean;
  /** Set when the record cannot be written: the first error decides. */
  error: { code: string; message: string } | null;
}

const BLANK = (v: FieldValue) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const NIL = (v: FieldValue) => v === null || v === undefined;

/** A stable, human-readable rendering used in previews, diffs and error messages. */
export function display(value: FieldValue): string | null {
  if (value === null || value === undefined) return null;
  if (isLookupValue(value)) return `${value.logicalName}(${value.id})`;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

export type RuleOutcome =
  | { ok: true; value: FieldValue; warning?: TransformationIssueDto }
  | { ok: false; code: string; message: string };

const ok = (value: FieldValue, warning?: TransformationIssueDto): RuleOutcome => ({
  ok: true,
  value,
  warning,
});
const fail = (code: string, message: string): RuleOutcome => ({ ok: false, code, message });

/** `2024-03-05` / `05/03/2024` … parsed only against the format the user configured. */
function parseWithFormat(raw: string, format: string): { y: number; m: number; d: number } | null {
  const patterns: Record<string, RegExp> = {
    'YYYY-MM-DD': /^(\d{4})-(\d{2})-(\d{2})/,
    'MM/DD/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})/,
    'DD/MM/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})/,
    'MM-DD-YYYY': /^(\d{2})-(\d{2})-(\d{4})/,
    'DD-MM-YYYY': /^(\d{2})-(\d{2})-(\d{4})/,
    'DD.MM.YYYY': /^(\d{2})\.(\d{2})\.(\d{4})/,
    YYYYMMDD: /^(\d{4})(\d{2})(\d{2})/,
  };
  const pattern = patterns[format];
  if (!pattern) return null;
  const m = pattern.exec(raw.trim());
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (format.startsWith('YYYY')) return { y: a, m: b, d: c };
  if (format.startsWith('MM')) return { y: c, m: a, d: b };
  return { y: c, m: b, d: a };
}

/** True for a calendar date that actually exists (2024-02-30 does not). */
function realDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * An unformatted date string is only accepted when it is unambiguous. `01/02/2020` is refused
 * because nobody can tell whether it means 2 January or 1 February, and guessing would silently
 * move a record's date by a month.
 */
const AMBIGUOUS_DATE = /^\s*\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\s*$/;

function toDateParts(value: FieldValue, rule: TransformationRule): RuleOutcome {
  if (NIL(value)) return ok(null);
  if (typeof value === 'number') {
    const asDate = new Date(value);
    return Number.isNaN(asDate.getTime())
      ? fail('INVALID_DATE', `${value} is not a valid date`)
      : ok(asDate.toISOString());
  }
  const raw = String(value).trim();
  if (raw === '') return ok(null);
  if (rule.inputFormat) {
    const parts = parseWithFormat(raw, rule.inputFormat);
    if (!parts) {
      return fail('INVALID_DATE', `"${raw}" does not match the configured format ${rule.inputFormat}`);
    }
    if (!realDate(parts.y, parts.m, parts.d)) {
      return fail('INVALID_DATE', `"${raw}" is not a real calendar date`);
    }
    const iso = `${String(parts.y).padStart(4, '0')}-${String(parts.m).padStart(2, '0')}-${String(
      parts.d,
    ).padStart(2, '0')}`;
    return ok(`${iso}T00:00:00.000Z`);
  }
  if (AMBIGUOUS_DATE.test(raw)) {
    return fail(
      'INVALID_DATE',
      `"${raw}" is ambiguous: it could be day/month or month/day. Configure the input format for this column.`,
    );
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return fail('INVALID_DATE', `"${raw}" is not a recognizable date`);
  // Date.parse rolls 2024-02-30 forward to 1 March; refuse rather than move the record's date.
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (isoDay && !realDate(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]))) {
    return fail('INVALID_DATE', `"${raw}" is not a real calendar date`);
  }
  return ok(new Date(parsed).toISOString());
}

function applyRule(value: FieldValue, rule: TransformationRule, ctx: TransformContext): RuleOutcome {
  const asText = () => (NIL(value) ? null : String(value));

  switch (rule.kind) {
    // --- string ---
    case 'TRIM':
      return ok(typeof value === 'string' ? value.trim() : value);
    case 'LEFT_TRIM':
      return ok(typeof value === 'string' ? value.replace(/^\s+/, '') : value);
    case 'RIGHT_TRIM':
      return ok(typeof value === 'string' ? value.replace(/\s+$/, '') : value);
    case 'UPPERCASE':
      return ok(typeof value === 'string' ? value.toUpperCase() : value);
    case 'LOWERCASE':
      return ok(typeof value === 'string' ? value.toLowerCase() : value);
    case 'REPLACE': {
      if (typeof value !== 'string' || !rule.find) return ok(value);
      // A literal replacement, never a regular expression: a rule must not be able to build one.
      return ok(value.split(rule.find).join(rule.replaceWith ?? ''));
    }
    case 'PREFIX':
      return NIL(value) ? ok(value) : ok(`${String(rule.value ?? '')}${String(value)}`);
    case 'SUFFIX':
      return NIL(value) ? ok(value) : ok(`${String(value)}${String(rule.value ?? '')}`);
    case 'SUBSTRING': {
      const text = asText();
      if (text === null) return ok(null);
      const start = Math.max(0, rule.start ?? 0);
      const end = rule.length == null ? undefined : start + Math.max(0, rule.length);
      const cut = text.slice(start, end);
      return ok(cut, cut.length < text.length ? lossWarning(text, cut) : undefined);
    }
    case 'TRUNCATE': {
      const text = asText();
      if (text === null) return ok(null);
      const max = rule.length ?? 0;
      if (max <= 0 || text.length <= max) return ok(text);
      const cut = text.slice(0, max);
      return ok(cut, lossWarning(text, cut));
    }

    // --- null / blank ---
    case 'EMPTY_TO_NULL':
      return ok(typeof value === 'string' && value.trim() === '' ? null : value);
    case 'NULL_TO_EMPTY':
      return ok(NIL(value) ? '' : value);
    case 'DEFAULT_IF_NULL':
      return ok(NIL(value) ? ((rule.value ?? null) as FieldValue) : value);
    case 'DEFAULT_IF_BLANK':
      return ok(BLANK(value) ? ((rule.value ?? null) as FieldValue) : value);
    case 'BLOCK_IF_NULL':
      return NIL(value)
        ? fail('REQUIRED_VALUE_MISSING', 'The source value is empty and this column requires a value')
        : ok(value);
    case 'CONSTANT':
      return ok((rule.value ?? null) as FieldValue);

    // --- type ---
    case 'TO_STRING':
      return ok(NIL(value) ? null : display(value));
    case 'TO_INTEGER': {
      if (NIL(value)) return ok(null);
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) return fail('INVALID_NUMBER', `"${display(value)}" is not a number`);
      const rounded = Math.trunc(n);
      return ok(
        rounded,
        rounded !== n ? lossWarning(String(n), String(rounded), 'decimal digits dropped') : undefined,
      );
    }
    case 'TO_DECIMAL': {
      if (NIL(value)) return ok(null);
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) return fail('INVALID_NUMBER', `"${display(value)}" is not a number`);
      if (rule.scale == null) return ok(n);
      const factor = 10 ** rule.scale;
      const rounded = Math.round(n * factor) / factor;
      return ok(
        rounded,
        rounded !== n
          ? lossWarning(String(n), String(rounded), 'rounded to the configured scale')
          : undefined,
      );
    }
    case 'TO_BOOLEAN': {
      if (NIL(value)) return ok(null);
      if (typeof value === 'boolean') return ok(value);
      const key = String(value).trim().toLowerCase();
      if (key === '') return ok(null);
      // Only the configured mapping decides. "ACTIVE" is not universally true, so nothing is
      // assumed beyond the unambiguous literals below.
      const configured = rule.map?.find((m) => m.from.trim().toLowerCase() === key);
      if (configured) return ok(Boolean(configured.to));
      if (['true', '1', 'y', 'yes'].includes(key)) return ok(true);
      if (['false', '0', 'n', 'no'].includes(key)) return ok(false);
      return fail(
        'VALUE_MAP_MISSING',
        `"${display(value)}" is not a recognized true/false value. Configure what it means.`,
      );
    }
    case 'TO_DATE': {
      const parsed = toDateParts(value, rule);
      if (!parsed.ok || parsed.value === null) return parsed;
      const dateOnly = String(parsed.value).slice(0, 10);
      const hadTime = !String(parsed.value).endsWith('T00:00:00.000Z');
      return ok(dateOnly, hadTime ? lossWarning(display(value), dateOnly, 'time of day dropped') : undefined);
    }
    case 'TO_DATETIME': {
      const parsed = toDateParts(value, rule);
      if (!parsed.ok) return parsed;
      return ok(parsed.value);
    }
    case 'TO_GUID': {
      if (NIL(value)) return ok(null);
      const text = String(value).trim().toLowerCase();
      if (text === '') return ok(null);
      const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const bare = /^[0-9a-f]{32}$/;
      if (guid.test(text)) return ok(text);
      if (bare.test(text)) {
        return ok(
          `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`,
        );
      }
      return fail('INVALID_GUID', `"${display(value)}" is not a GUID`);
    }

    // --- value mapping ---
    case 'VALUE_MAP': {
      if (NIL(value)) return ok(null);
      const key = String(value).trim().toLowerCase();
      const hit = rule.map?.find((m) => m.from.trim().toLowerCase() === key);
      if (hit) return ok(hit.to as FieldValue);
      const policy = rule.onUnmapped ?? 'BLOCK';
      if (policy === 'IGNORE') return ok(null);
      if (policy === 'DEFAULT') return ok((rule.defaultValue ?? null) as FieldValue);
      return fail('VALUE_MAP_MISSING', `"${display(value)}" has no mapping to a target value`);
    }

    // --- composition ---
    case 'CONCAT': {
      const parts: string[] = [];
      for (const part of rule.parts ?? []) {
        if (part.literal !== undefined && part.literal !== null) {
          parts.push(part.literal);
          continue;
        }
        if (!part.field) continue;
        const other = ctx.record?.values[part.field] ?? null;
        const text = display(other);
        if (rule.skipEmptyParts !== false && (text === null || text.trim() === '')) continue;
        parts.push(text ?? '');
      }
      const joined = parts.join(rule.separator ?? '');
      return ok(joined === '' ? null : joined);
    }

    // --- conditional ---
    case 'IF_THEN': {
      if (!rule.condition || !evaluate(rule.condition, value, ctx)) return ok(value);
      if (rule.action === 'SET_NULL') return ok(null);
      if (rule.action === 'APPLY') {
        let current = value;
        for (const inner of rule.then ?? []) {
          const result = applyRule(current, inner, ctx);
          if (!result.ok) return result;
          current = result.value;
        }
        return ok(current);
      }
      return ok((rule.value ?? null) as FieldValue);
    }

    default:
      return ok(value);
  }
}

function lossWarning(
  before: string | null,
  after: string | null,
  why = 'value shortened',
): TransformationIssueDto {
  return {
    severity: 'WARNING',
    code: 'LOSSY_TRANSFORMATION',
    message: `${why}: "${before}" → "${after}"`,
  };
}

/** Evaluates one declarative condition. Operators are a closed list; there is no expression parser. */
export function evaluate(
  condition: TransformationCondition,
  current: FieldValue,
  ctx: TransformContext,
): boolean {
  const subject = condition.field ? (ctx.record?.values[condition.field] ?? null) : current;
  const text = display(subject);
  const expected = condition.value === undefined || condition.value === null ? null : String(condition.value);
  switch (condition.operator) {
    case 'IS_NULL':
      return NIL(subject);
    case 'IS_NOT_NULL':
      return !NIL(subject);
    case 'IS_BLANK':
      return BLANK(subject);
    case 'EQUALS':
      return (text ?? '').trim().toLowerCase() === (expected ?? '').trim().toLowerCase();
    case 'NOT_EQUALS':
      return (text ?? '').trim().toLowerCase() !== (expected ?? '').trim().toLowerCase();
    case 'CONTAINS':
      return (text ?? '').toLowerCase().includes((expected ?? '').toLowerCase());
    case 'STARTS_WITH':
      return (text ?? '').toLowerCase().startsWith((expected ?? '').toLowerCase());
    case 'GREATER_THAN':
      return Number(text) > Number(expected);
    case 'LESS_THAN':
      return Number(text) < Number(expected);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Runs a pipeline over a value without the type conversion or target checks. Used by the preview
 * of a single rule and by the compatibility adapters; the full path is {@link transformField}.
 */
export function applyRules(
  value: FieldValue,
  rules: TransformationRule[],
  ctx: TransformContext = {},
): RuleOutcome {
  let current = value;
  for (const rule of rules) {
    const result = applyRule(current, rule, ctx);
    if (!result.ok) return result;
    current = result.value;
  }
  return ok(current);
}

/** Plans written before pipelines existed stored one step; it becomes a one-rule pipeline. */
export function rulesFromLegacy(transform: FieldTransformDto | null | undefined): TransformationRule[] {
  if (!transform || transform.kind === 'DIRECT' || transform.kind === 'CHOICE_MAP') return [];
  const map: Record<string, TransformationRule['kind']> = {
    TRIM: 'TRIM',
    UPPER: 'UPPERCASE',
    LOWER: 'LOWERCASE',
    CONSTANT: 'CONSTANT',
    DEFAULT_IF_NULL: 'DEFAULT_IF_NULL',
  };
  const kind = map[transform.kind];
  return kind ? [{ kind, value: transform.value ?? null }] : [];
}

/**
 * A choice mapping is a VALUE_MAP rule; this is what makes the two features one mechanism.
 *
 * Three states, and the difference between them matters: a value someone mapped becomes its
 * target choice, a value someone explicitly EXCLUDED becomes empty (a decision), and a value
 * nobody has looked at yet blocks the record (never a guess).
 */
export function choiceMapRule(choiceMap: ChoiceMappingDto): TransformationRule {
  return {
    kind: 'VALUE_MAP',
    map: choiceMap.entries
      .filter((e) => e.status === 'IGNORED' || e.targetValue !== null)
      .map((e) => ({ from: e.sourceValue, to: e.status === 'IGNORED' ? null : e.targetValue })),
    onUnmapped: choiceMap.defaultTargetValue !== null ? 'DEFAULT' : 'BLOCK',
    defaultValue: choiceMap.defaultTargetValue,
  };
}

/**
 * Runs one field through the whole path: the configured pipeline, then the choice map, then the
 * conversion into the target column's type, then the target's own constraints.
 */
export function transformField(input: TransformFieldInput): TransformFieldResult {
  const ctx = input.context ?? {};
  const applied: AppliedTransformationDto[] = [];
  const issues: TransformationIssueDto[] = [];
  let lossy = false;
  let current: FieldValue = input.value ?? null;

  const rules: TransformationRule[] = [
    ...(input.rules?.length ? input.rules : rulesFromLegacy(input.legacyTransform)),
  ];
  // Excluded choice values are dropped by the map itself, so it always runs last.
  if (input.choiceMap) rules.push(choiceMapRule(input.choiceMap));

  for (const rule of rules) {
    const before = display(current);
    const result = applyRule(current, rule, ctx);
    if (!result.ok) {
      issues.push({
        severity: 'ERROR',
        code: result.code,
        message: result.message,
        field: input.source.logicalName,
      });
      return {
        ok: false,
        value: null,
        originalValue: input.value ?? null,
        applied,
        issues,
        lossy,
        error: { code: result.code, message: result.message },
      };
    }
    current = result.value;
    const after = display(current);
    const ruleLossy = isLossyRule(rule) && before !== after;
    if (ruleLossy) lossy = true;
    if (result.warning) issues.push({ ...result.warning, field: input.source.logicalName });
    if (before !== after) applied.push({ kind: rule.kind, before, after, lossy: ruleLossy });
  }

  // Type conversion into the target column.
  const crossProvider = Boolean(input.source.sql) !== Boolean(input.target.sql);
  const converted = crossProvider
    ? convertValue(current, input.source, input.target)
    : transformValue(input.source, input.target, current);
  if (!converted.ok) {
    const code = converted.error.includes('characters, target allows')
      ? 'STRING_TOO_LONG'
      : converted.error.toLowerCase().includes('date')
        ? 'INVALID_DATE'
        : converted.error.toLowerCase().includes('number')
          ? 'INVALID_NUMBER'
          : 'TRANSFORMATION_FAILED';
    issues.push({
      severity: 'ERROR',
      code,
      message: converted.error,
      field: input.source.logicalName,
    });
    return {
      ok: false,
      value: null,
      originalValue: input.value ?? null,
      applied,
      issues,
      lossy,
      error: { code, message: converted.error },
    };
  }
  current = converted.value;

  // The target's own constraints, checked for every provider pair rather than only across them.
  const constraint = checkTargetConstraints(current, input.target);
  if (constraint) {
    issues.push({ ...constraint, field: input.source.logicalName });
    if (constraint.severity === 'ERROR') {
      return {
        ok: false,
        value: null,
        originalValue: input.value ?? null,
        applied,
        issues,
        lossy,
        error: { code: constraint.code, message: constraint.message },
      };
    }
  }

  return {
    ok: true,
    value: current,
    originalValue: input.value ?? null,
    applied,
    issues,
    lossy,
    error: null,
  };
}

/** Length and required-value checks against the target column, after every transformation. */
export function checkTargetConstraints(
  value: FieldValue,
  target: AttributeMeta,
): TransformationIssueDto | null {
  const max = target.maxLength ?? null;
  if (typeof value === 'string' && max !== null && max > 0 && value.length > max) {
    return {
      severity: 'ERROR',
      code: 'STRING_TOO_LONG',
      message: `value is ${value.length} characters, target allows ${max}`,
    };
  }
  const required =
    target.requiredLevel === 'ApplicationRequired' || target.requiredLevel === 'SystemRequired';
  if (required && NIL(value)) {
    return {
      severity: 'ERROR',
      code: 'REQUIRED_VALUE_MISSING',
      message: `${target.displayName} is required in the target but the transformed value is empty`,
    };
  }
  return null;
}
