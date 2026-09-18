/**
 * Field-level transformations and choice (value) mapping.
 *
 * Deliberately a small, declarative set rather than a scripting language: every transformation is
 * persisted configuration that can be shown in the UI, exported, and reasoned about by preflight.
 * A value that cannot be transformed is always reported, never quietly dropped or guessed.
 */
import type { ChoiceMappingDto, FieldTransformDto } from '../../../shared/domain';
import type { AttributeMeta, FieldValue } from '../../../shared/metadata';
import { convertValue } from '../connectors/sql/type-map';
import { transformValue } from './values';

export type TransformOutcome = { ok: true; value: FieldValue } | { ok: false; code: string; error: string };

/** Applies the configured transformation to the raw source value, before type conversion. */
export function applyTransform(
  value: FieldValue,
  transform: FieldTransformDto | null | undefined,
): FieldValue {
  if (!transform || transform.kind === 'DIRECT' || transform.kind === 'CHOICE_MAP') return value;
  switch (transform.kind) {
    case 'CONSTANT':
      return (transform.value ?? null) as FieldValue;
    case 'DEFAULT_IF_NULL':
      return value === null || value === undefined || value === ''
        ? ((transform.value ?? null) as FieldValue)
        : value;
    case 'TRIM':
      return typeof value === 'string' ? value.trim() : value;
    case 'UPPER':
      return typeof value === 'string' ? value.toUpperCase() : value;
    case 'LOWER':
      return typeof value === 'string' ? value.toLowerCase() : value;
    default:
      return value;
  }
}

/** Looks a source value up in a choice mapping. */
export function applyChoiceMap(value: FieldValue, choiceMap: ChoiceMappingDto): TransformOutcome {
  if (value === null || value === undefined) return { ok: true, value: null };
  const key = String(value).trim();
  const entry = choiceMap.entries.find((e) => e.sourceValue.toLowerCase() === key.toLowerCase());
  if (entry && entry.status === 'IGNORED') return { ok: true, value: null };
  if (entry && entry.targetValue !== null) return { ok: true, value: entry.targetValue };
  if (choiceMap.defaultTargetValue !== null) return { ok: true, value: choiceMap.defaultTargetValue };
  // An unmapped choice value is an issue for a person to resolve, never a guess.
  return {
    ok: false,
    code: 'CHOICE_UNMAPPED',
    error: `Source value "${key}" has no mapping to a target choice`,
  };
}

/**
 * Turns one source value into the value the target column will receive: configured
 * transformation, then choice mapping or type conversion.
 */
export function transformField(input: {
  value: FieldValue;
  source: AttributeMeta;
  target: AttributeMeta;
  transform?: FieldTransformDto | null;
  choiceMap?: ChoiceMappingDto | null;
}): TransformOutcome {
  const staged = applyTransform(input.value, input.transform);
  if (input.choiceMap) return applyChoiceMap(staged, input.choiceMap);

  // Between providers the SQL/Dataverse converter knows the rules that only exist across
  // systems (truncation, overflow, GUID to lookup, calendar-invalid dates).
  const crossProvider = Boolean(input.source.sql) !== Boolean(input.target.sql);
  if (crossProvider) {
    const converted = convertValue(staged, input.source, input.target);
    return converted.ok
      ? { ok: true, value: converted.value }
      : { ok: false, code: 'VALUE_CONVERSION', error: converted.error };
  }
  const converted = transformValue(input.source, input.target, staged);
  if (!converted.ok) return { ok: false, code: 'VALUE_CONVERSION', error: converted.error };
  return checkLength(converted.value, input.target);
}

/**
 * A value can be too long for the target column even when the two column definitions are
 * identical, because the data itself is longer than the declaration allows. Catching it here
 * means the preflight reports it instead of the database rejecting it mid-migration.
 */
function checkLength(value: FieldValue, target: AttributeMeta): TransformOutcome {
  const max = target.maxLength ?? null;
  if (typeof value === 'string' && max !== null && max > 0 && value.length > max) {
    return {
      ok: false,
      code: 'VALUE_CONVERSION',
      error: `value is ${value.length} characters, target allows ${max}`,
    };
  }
  return { ok: true, value };
}
