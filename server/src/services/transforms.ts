/**
 * Compatibility surface over the transformation engine.
 *
 * Everything here delegates to `transformation/engine.ts`. There is deliberately no second
 * implementation: preview, preflight, migration and validation must agree on what a value
 * becomes, and the only way to guarantee that is for one module to decide it.
 */
import type { ChoiceMappingDto, FieldTransformDto } from '../../../shared/domain';
import type { AttributeMeta, FieldValue } from '../../../shared/metadata';
import { applyRules, choiceMapRule, rulesFromLegacy, transformField } from './transformation/engine';

export type TransformOutcome = { ok: true; value: FieldValue } | { ok: false; code: string; error: string };

/** Applies a legacy single-step transformation. */
export function applyTransform(
  value: FieldValue,
  transform: FieldTransformDto | null | undefined,
): FieldValue {
  const result = applyRules(value, rulesFromLegacy(transform));
  return result.ok ? result.value : value;
}

/** Looks a source value up in a choice mapping. */
export function applyChoiceMap(value: FieldValue, choiceMap: ChoiceMappingDto): TransformOutcome {
  const result = applyRules(value, [choiceMapRule(choiceMap)]);
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, code: result.code, error: result.message };
}

/** The whole path for one field: pipeline, choice map, type conversion, target constraints. */
export function transformFieldValue(input: {
  value: FieldValue;
  source: AttributeMeta;
  target: AttributeMeta;
  transform?: FieldTransformDto | null;
  choiceMap?: ChoiceMappingDto | null;
}): TransformOutcome {
  const result = transformField({
    value: input.value,
    source: input.source,
    target: input.target,
    legacyTransform: input.transform,
    choiceMap: input.choiceMap,
  });
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, code: result.error!.code, error: result.error!.message };
}

export { transformField } from './transformation/engine';
