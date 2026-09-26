import {
  type TransformationCondition,
  type TransformationKind,
  type TransformationRule,
} from '../../../shared/domain';
import { transformationRulesSchema } from '../routes/schemas';
import { rowsByHeader, type XlsxReadSheet, type XlsxSheet, type XlsxValue } from '../lib/xlsx';

/**
 * Transformation pipelines as spreadsheet rows.
 *
 * The first attempt squeezed a pipeline into one text cell, which worked for `TRIM > TRUNCATE(160)`
 * and could not express a value map, a concatenation or a conditional at all — so those were
 * exported as `VALUE_MAP(…)` and refused on import. That is the wrong trade: the rules a business
 * analyst most needs to edit in a spreadsheet are exactly the value maps.
 *
 * So the workbook carries a normalized representation instead: one row per rule step, with the list
 * -valued parts (a value map's entries, a concatenation's pieces) in their own sheets keyed back to
 * the step. Every kind the engine supports round-trips, and what comes back is validated by the
 * same zod schema the transformation editor posts through — a workbook cannot describe a pipeline
 * the API would reject.
 */

/** Written in the Rule column to say "this column has no transformations", explicitly. */
export const CLEAR_RULE = 'NONE';

export const TRANSFORMATION_SHEET = 'Transformations';
export const VALUE_MAP_SHEET = 'Value maps';
export const CONCAT_SHEET = 'Concat parts';

/** One row per rule. Most columns are blank for most rules; each is obvious when it is not. */
export const TRANSFORMATION_COLUMNS = [
  'Source table',
  'Source field',
  'Step',
  'Rule',
  'Find',
  'Replace with',
  'Value',
  'Start',
  'Length',
  'Scale',
  'Input format',
  'Separator',
  'Skip empty parts',
  'On unmapped',
  'Default value',
  'Condition field',
  'Condition operator',
  'Condition value',
  'Action',
  'Inside step',
] as const;

export const VALUE_MAP_COLUMNS = ['Source table', 'Source field', 'Step', 'From', 'To'] as const;

export const CONCAT_COLUMNS = ['Source table', 'Source field', 'Step', 'Order', 'Field', 'Literal'] as const;

export interface FieldPipeline {
  table: string;
  field: string;
  rules: TransformationRule[];
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The three sheets, built from the pipelines a plan currently has. */
export function transformationSheets(pipelines: FieldPipeline[]): XlsxSheet[] {
  const ruleRows: XlsxValue[][] = [];
  const mapRows: XlsxValue[][] = [];
  const partRows: XlsxValue[][] = [];

  for (const { table, field, rules } of pipelines) {
    let step = 0;
    const emit = (rule: TransformationRule, insideStep: number | null) => {
      step += 1;
      const mine = step;
      ruleRows.push([
        table,
        field,
        mine,
        rule.kind,
        rule.find ?? '',
        rule.replaceWith ?? '',
        scalar(rule.value),
        rule.start ?? '',
        rule.length ?? '',
        rule.scale ?? '',
        rule.inputFormat ?? '',
        rule.separator ?? '',
        boolText(rule.skipEmptyParts),
        rule.onUnmapped ?? '',
        scalar(rule.defaultValue),
        rule.condition?.field ?? '',
        rule.condition?.operator ?? '',
        scalar(rule.condition?.value),
        rule.action ?? '',
        insideStep ?? '',
      ]);
      for (const entry of rule.map ?? []) {
        mapRows.push([table, field, mine, entry.from, scalar(entry.to)]);
      }
      (rule.parts ?? []).forEach((part, i) => {
        partRows.push([table, field, mine, i + 1, part.field ?? '', part.literal ?? '']);
      });
      // A conditional's own rules are listed after it, pointing back at its step.
      for (const nested of rule.then ?? []) emit(nested, mine);
    };
    for (const rule of rules) emit(rule, null);
  }

  return [
    {
      name: TRANSFORMATION_SHEET,
      columns: TRANSFORMATION_COLUMNS.map((header) => ({ header })),
      rows: ruleRows,
      notes: [
        'One row per transformation step, in the order they run. This sheet is what gets imported.',
        `A column with no row here is left exactly as it is. To remove a column's transformations, give it one row with Rule = ${CLEAR_RULE}.`,
        'Step numbers only order the rows within one source field; renumber freely, they are read in the order given.',
        'A conditional (IF_THEN) with Action = APPLY runs the rules whose "Inside step" is its own step number.',
        'Value maps and concatenation pieces live on the "Value maps" and "Concat parts" sheets, keyed by the same table, field and step.',
      ],
    },
    {
      name: VALUE_MAP_SHEET,
      columns: VALUE_MAP_COLUMNS.map((header) => ({
        header,
        width: header === 'From' || header === 'To' ? 32 : undefined,
      })),
      rows: mapRows,
      notes: [
        'The entries of a VALUE_MAP or TO_BOOLEAN step. Step must match a row on the Transformations sheet.',
        'Leave To empty to map a source value onto nothing; write TRUE or FALSE for a boolean target.',
      ],
    },
    {
      name: CONCAT_SHEET,
      columns: CONCAT_COLUMNS.map((header) => ({ header })),
      rows: partRows,
      notes: [
        'The pieces of a CONCAT step, in the order given. Fill in either Field (a source column) or Literal, not both.',
      ],
    },
  ];
}

/** A one-line rendering for the reference column on the field-mapping sheet. */
export function summarizeRules(rules: TransformationRule[]): string {
  return rules.map(summarizeRule).join(' > ');
}

function summarizeRule(rule: TransformationRule): string {
  switch (rule.kind) {
    case 'TRUNCATE':
      return rule.length == null ? 'TRUNCATE' : `TRUNCATE(${rule.length})`;
    case 'SUBSTRING':
      return `SUBSTRING(${rule.start ?? 0},${rule.length ?? 0})`;
    case 'TO_DECIMAL':
      return rule.scale == null ? 'TO_DECIMAL' : `TO_DECIMAL(${rule.scale})`;
    case 'REPLACE':
      return `REPLACE(${rule.find ?? ''},${rule.replaceWith ?? ''})`;
    case 'PREFIX':
    case 'SUFFIX':
    case 'CONSTANT':
    case 'DEFAULT_IF_NULL':
    case 'DEFAULT_IF_BLANK':
      return rule.value == null ? rule.kind : `${rule.kind}(${String(rule.value)})`;
    case 'VALUE_MAP':
      return `VALUE_MAP(${(rule.map ?? []).length} value(s))`;
    case 'CONCAT':
      return `CONCAT(${(rule.parts ?? []).length} part(s))`;
    case 'IF_THEN':
      return `IF ${rule.condition?.field ?? ''} ${rule.condition?.operator ?? ''} ${
        rule.condition?.value ?? ''
      } THEN ${rule.action ?? ''}`;
    default:
      return rule.kind;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ParsedPipelines {
  /** Keyed `table.toLowerCase()\u0000field.toLowerCase()`. */
  byField: Map<string, TransformationRule[]>;
  /** Problems found while reading, each naming the row it came from. */
  problems: { row: number; table: string; field: string; reason: string }[];
  /** False when the workbook has no Transformations sheet at all. */
  present: boolean;
}

export const pipelineKey = (table: string, field: string) =>
  `${table.trim().toLowerCase()}\u0000${field.trim().toLowerCase()}`;

/**
 * Reads the three sheets back into pipelines.
 *
 * A row that cannot be understood becomes a problem naming the row, and the whole field's pipeline
 * is dropped rather than applied half-configured: half a value map is not a smaller value map, it
 * is a different one.
 */
export function readTransformationSheets(sheets: XlsxReadSheet[]): ParsedPipelines {
  const out: ParsedPipelines = { byField: new Map(), problems: [], present: false };

  const rulesSheet = findSheet(sheets, TRANSFORMATION_SHEET, ['Source table', 'Source field', 'Rule']);
  if (!rulesSheet) return out;
  out.present = true;

  const maps = readValueMaps(findSheet(sheets, VALUE_MAP_SHEET, ['Source table', 'Source field', 'From']));
  const parts = readConcatParts(findSheet(sheets, CONCAT_SHEET, ['Source table', 'Source field', 'Order']));

  // Rules in the order the sheet lists them, grouped per field.
  const perField = new Map<string, { row: number; cells: Record<string, string> }[]>();
  const names = new Map<string, { table: string; field: string }>();
  rulesSheet.rows.forEach((cells, i) => {
    const table = cells.sourcetable ?? '';
    const field = cells.sourcefield ?? '';
    if (!table || !field) return;
    const key = pipelineKey(table, field);
    names.set(key, { table, field });
    const list = perField.get(key) ?? [];
    list.push({ row: i + 1, cells });
    perField.set(key, list);
  });

  for (const [key, rows] of perField) {
    const { table, field } = names.get(key)!;
    const built = buildPipeline(table, field, rows, maps, parts);
    if (built.problems.length) {
      out.problems.push(...built.problems);
      continue;
    }
    // The same schema the transformation editor posts through, so a workbook cannot describe a
    // pipeline the API would refuse.
    const checked = transformationRulesSchema.safeParse(built.rules);
    if (!checked.success) {
      out.problems.push({
        row: rows[0].row,
        table,
        field,
        reason: checked.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || 'rules'}: ${issue.message}`)
          .join('; '),
      });
      continue;
    }
    out.byField.set(key, checked.data as TransformationRule[]);
  }
  return out;
}

function buildPipeline(
  table: string,
  field: string,
  rows: { row: number; cells: Record<string, string> }[],
  maps: Map<string, { from: string; to: string }[]>,
  parts: Map<string, { order: number; field: string; literal: string }[]>,
): { rules: TransformationRule[]; problems: ParsedPipelines['problems'] } {
  const problems: ParsedPipelines['problems'] = [];
  const top: TransformationRule[] = [];
  /** Step number as written in the sheet -> the rule built from it, for resolving "Inside step". */
  const byStep = new Map<string, TransformationRule>();
  const nested: { row: number; parent: string; rule: TransformationRule }[] = [];

  for (const { row, cells } of rows) {
    const named = (cells.rule ?? '').trim().toUpperCase();
    if (!named) continue;
    // An explicit "no transformations" row: the pipeline is cleared rather than left as it was.
    // The field still counts as mentioned, so an empty pipeline is applied.
    if (named === CLEAR_RULE) continue;
    const kind = named as TransformationKind;
    const step = (cells.step ?? '').trim();
    const rule: TransformationRule = { kind };

    assignIf(rule, 'find', cells.find);
    assignIf(rule, 'replaceWith', cells.replacewith);
    if (cells.value !== undefined && cells.value !== '') rule.value = coerce(cells.value);
    numberInto(rule, 'start', cells.start, row, table, field, problems);
    numberInto(rule, 'length', cells.length, row, table, field, problems);
    numberInto(rule, 'scale', cells.scale, row, table, field, problems);
    assignIf(rule, 'inputFormat', cells.inputformat);
    assignIf(rule, 'separator', cells.separator);
    if (cells.skipemptyparts) rule.skipEmptyParts = isTrue(cells.skipemptyparts);
    if (cells.onunmapped) rule.onUnmapped = cells.onunmapped.trim().toUpperCase() as never;
    if (cells.defaultvalue !== undefined && cells.defaultvalue !== '') {
      rule.defaultValue = coerce(cells.defaultvalue);
    }
    if (cells.action) rule.action = cells.action.trim().toUpperCase() as never;

    if (cells.conditionoperator) {
      const condition: TransformationCondition = {
        field: cells.conditionfield || null,
        operator: cells.conditionoperator.trim().toUpperCase() as TransformationCondition['operator'],
      };
      if (cells.conditionvalue !== undefined && cells.conditionvalue !== '') {
        condition.value = coerce(cells.conditionvalue);
      }
      rule.condition = condition;
    }

    const stepKey = `${pipelineKey(table, field)}\u0000${step}`;
    const mapEntries = maps.get(stepKey);
    if (mapEntries?.length) {
      rule.map = mapEntries.map((e) => ({ from: e.from, to: e.to === '' ? null : coerce(e.to) }));
    }
    const concatParts = parts.get(stepKey);
    if (concatParts?.length) {
      rule.parts = [...concatParts]
        .sort((a, b) => a.order - b.order)
        .map((p) => ({ field: p.field || null, literal: p.literal || null }));
    }

    const inside = (cells.insidestep ?? '').trim();
    if (inside) nested.push({ row, parent: inside, rule });
    else top.push(rule);
    if (step) byStep.set(step, rule);
  }

  for (const { row, parent, rule } of nested) {
    const host = byStep.get(parent);
    if (!host) {
      problems.push({
        row,
        table,
        field,
        reason: `"Inside step" ${parent} does not match any step for this column`,
      });
      continue;
    }
    if (host.then === undefined) host.then = [];
    host.then.push(rule);
  }

  return { rules: top, problems };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The sheet by name if it is there, else any sheet carrying those headers. */
function findSheet(
  sheets: XlsxReadSheet[],
  name: string,
  required: string[],
): { rows: Record<string, string>[] } | null {
  const named = sheets.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
  const candidates = named ? [named, ...sheets] : sheets;
  for (const sheet of candidates) {
    const found = rowsByHeader(sheet, required);
    if (found) return found;
  }
  return null;
}

/** Value-map entries, keyed by table, field and step, in the order the sheet lists them. */
function readValueMaps(
  sheet: { rows: Record<string, string>[] } | null,
): Map<string, { from: string; to: string }[]> {
  const out = new Map<string, { from: string; to: string }[]>();
  for (const cells of sheet?.rows ?? []) {
    const table = cells.sourcetable ?? '';
    const field = cells.sourcefield ?? '';
    if (!table || !field) continue;
    const key = `${pipelineKey(table, field)}\u0000${(cells.step ?? '').trim()}`;
    const list = out.get(key) ?? [];
    list.push({ from: cells.from ?? '', to: cells.to ?? '' });
    out.set(key, list);
  }
  return out;
}

/** Concatenation pieces, keyed the same way. `Order` decides the sequence, not row position. */
function readConcatParts(
  sheet: { rows: Record<string, string>[] } | null,
): Map<string, { order: number; field: string; literal: string }[]> {
  const out = new Map<string, { order: number; field: string; literal: string }[]>();
  for (const [i, cells] of (sheet?.rows ?? []).entries()) {
    const table = cells.sourcetable ?? '';
    const field = cells.sourcefield ?? '';
    if (!table || !field) continue;
    const key = `${pipelineKey(table, field)}\u0000${(cells.step ?? '').trim()}`;
    const list = out.get(key) ?? [];
    const order = Number(cells.order);
    list.push({
      order: Number.isFinite(order) ? order : i + 1,
      field: cells.field ?? '',
      literal: cells.literal ?? '',
    });
    out.set(key, list);
  }
  return out;
}

const scalar = (value: string | number | boolean | null | undefined): XlsxValue => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return value;
};

const boolText = (value: boolean | null | undefined) =>
  value === null || value === undefined ? '' : value ? 'TRUE' : 'FALSE';

const isTrue = (value: string) => ['true', 'yes', '1', 'y'].includes(value.trim().toLowerCase());

/** A cell's value as the closest scalar: a number if it reads as one, a boolean if it says so. */
function coerce(raw: string): string | number | boolean {
  const text = raw.trim();
  const upper = text.toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  if (text !== '' && /^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

function assignIf<K extends 'find' | 'replaceWith' | 'inputFormat' | 'separator'>(
  rule: TransformationRule,
  key: K,
  value: string | undefined,
) {
  if (value !== undefined && value !== '') rule[key] = value;
}

function numberInto(
  rule: TransformationRule,
  key: 'start' | 'length' | 'scale',
  value: string | undefined,
  row: number,
  table: string,
  field: string,
  problems: ParsedPipelines['problems'],
) {
  if (value === undefined || value.trim() === '') return;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    problems.push({ row, table, field, reason: `${key} must be a number, got "${value}"` });
    return;
  }
  rule[key] = n;
}
