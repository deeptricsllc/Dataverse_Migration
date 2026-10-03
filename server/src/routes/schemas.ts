import { z } from 'zod';
import { CONDITION_OPERATORS, TRANSFORMATION_KINDS } from '../../../shared/domain';

/**
 * Request shapes shared by more than one entry point.
 *
 * A transformation pipeline can now arrive two ways — typed into the editor, or filled into a
 * mapping workbook and imported — and both have to be validated identically. Two schemas would
 * eventually disagree, and the one that disagreed would be the one accepting something the engine
 * cannot run.
 */

/** A Dataverse logical name or a schema-qualified SQL table. */
export const tableNameSchema = z.string().regex(/^[A-Za-z0-9_.]{1,257}$/);
/** A SQL column or Dataverse attribute name. */
export const fieldNameSchema = z.string().regex(/^[A-Za-z0-9_ #$@]{1,128}$/);

const conditionSchema = z.object({
  field: fieldNameSchema.nullish(),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.union([z.string().max(400), z.number(), z.boolean(), z.null()]).optional(),
});

/**
 * One transformation rule. The `kind` is a closed enum, so configuration can never smuggle in code:
 * there is no expression, script or SQL anywhere in this shape.
 */
const baseRule = {
  kind: z.enum(TRANSFORMATION_KINDS),
  find: z.string().max(200).nullish(),
  replaceWith: z.string().max(200).nullish(),
  value: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]).optional(),
  start: z.number().int().min(0).max(10_000).nullish(),
  length: z.number().int().min(0).max(1_000_000).nullish(),
  inputFormat: z.string().max(20).nullish(),
  scale: z.number().int().min(0).max(10).nullish(),
  map: z
    .array(
      z.object({
        from: z.string().max(400),
        to: z.union([z.string().max(400), z.number(), z.boolean(), z.null()]),
      }),
    )
    .max(500)
    .optional(),
  onUnmapped: z.enum(['BLOCK', 'IGNORE', 'DEFAULT']).optional(),
  defaultValue: z.union([z.string().max(400), z.number(), z.boolean(), z.null()]).optional(),
  parts: z
    .array(z.object({ field: fieldNameSchema.nullish(), literal: z.string().max(200).nullish() }))
    .max(20)
    .optional(),
  separator: z.string().max(20).nullish(),
  skipEmptyParts: z.boolean().nullish(),
  condition: conditionSchema.nullish(),
  action: z.enum(['SET_VALUE', 'SET_NULL', 'APPLY']).nullish(),
};

/** One level of nesting only: a conditional may apply rules, but those rules may not nest again. */
export const transformationRuleSchema = z.object({
  ...baseRule,
  then: z.array(z.object(baseRule)).max(10).optional(),
});

export const transformationRulesSchema = z.array(transformationRuleSchema).max(20);
