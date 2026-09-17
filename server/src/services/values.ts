import { isLookupValue, type AttributeMeta, type FieldValue } from '../../../shared/metadata';

export type TransformResult = { ok: true; value: FieldValue } | { ok: false; error: string };

const round = (n: number, precision: number | null | undefined) =>
  precision == null ? n : Math.round(n * 10 ** precision) / 10 ** precision;

/** Converts a source column value into the representation expected by the target column. */
export function transformValue(
  source: AttributeMeta,
  target: AttributeMeta,
  value: FieldValue | undefined,
): TransformResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  switch (target.type) {
    case 'String':
    case 'Memo':
      if (typeof value === 'object') return { ok: false, error: `Cannot convert ${source.type} to text` };
      return { ok: true, value: String(value) };
    case 'Integer':
    case 'BigInt': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: `Value is not a number` };
      return { ok: true, value: Math.round(n) };
    }
    case 'Decimal':
    case 'Money':
    case 'Double': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: `Value is not a number` };
      return { ok: true, value: round(n, target.precision) };
    }
    case 'Boolean':
      if (typeof value !== 'boolean') return { ok: false, error: 'Value is not a boolean' };
      return { ok: true, value };
    case 'DateTime': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
        return { ok: false, error: 'Invalid date/time' };
      if (target.dateTimeBehavior === 'DateOnly') return { ok: true, value: value.slice(0, 10) };
      return { ok: true, value: new Date(value).toISOString() };
    }
    case 'Picklist':
    case 'State':
    case 'Status':
      if (typeof value !== 'number') return { ok: false, error: 'Choice value must be numeric' };
      return { ok: true, value };
    case 'MultiSelectPicklist':
      if (!Array.isArray(value)) return { ok: false, error: 'Multi-select value must be a list' };
      return { ok: true, value: [...value].sort((a, b) => a - b) };
    case 'Uniqueidentifier':
      return { ok: true, value: String(value).toLowerCase() };
    case 'Lookup':
    case 'Customer':
    case 'Owner':
      if (!isLookupValue(value)) return { ok: false, error: 'Lookup value expected' };
      return { ok: true, value };
    default:
      return { ok: true, value };
  }
}

/** Normalizes a value so formatting-only differences do not register as mismatches. */
export function normalizeForCompare(
  attr: AttributeMeta,
  value: FieldValue | undefined,
): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  switch (attr.type) {
    case 'String':
    case 'Memo': {
      const s = String(value).replace(/\r\n/g, '\n').trimEnd();
      return s === '' ? null : s;
    }
    case 'Integer':
    case 'BigInt':
    case 'Decimal':
    case 'Money':
    case 'Double':
    case 'Picklist':
    case 'State':
    case 'Status': {
      const n = Number(value);
      return Number.isFinite(n) ? round(n, attr.precision ?? 10) : String(value);
    }
    case 'Boolean':
      return Boolean(value);
    case 'DateTime': {
      const s = String(value);
      if (attr.dateTimeBehavior === 'DateOnly') return s.slice(0, 10);
      const ms = Date.parse(s);
      return Number.isNaN(ms) ? s : new Date(Math.floor(ms / 1000) * 1000).toISOString();
    }
    case 'MultiSelectPicklist':
      return Array.isArray(value) ? [...value].sort((a, b) => a - b).join(',') : String(value);
    case 'Lookup':
    case 'Customer':
    case 'Owner':
    case 'Uniqueidentifier':
      return isLookupValue(value) ? value.id.toLowerCase() : String(value).toLowerCase();
    default:
      return typeof value === 'object' ? JSON.stringify(value) : value;
  }
}

export function valuesEqual(
  attr: AttributeMeta,
  a: FieldValue | undefined,
  b: FieldValue | undefined,
): boolean {
  const na = normalizeForCompare(attr, a);
  const nb = normalizeForCompare(attr, b);
  if (typeof na === 'number' && typeof nb === 'number') {
    const tolerance = attr.precision != null ? 10 ** -attr.precision / 2 : 1e-9;
    return Math.abs(na - nb) <= tolerance;
  }
  return na === nb;
}

const MAX_DISPLAY = 256;

/** Renders a value for reports, masking secured columns and truncating long text. */
export function displayValue(attr: AttributeMeta | undefined, value: FieldValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (attr?.isSecured) return '•••• (secured column)';
  let s: string;
  if (isLookupValue(value)) s = `${value.logicalName}(${value.id})`;
  else if (Array.isArray(value)) s = value.join(', ');
  else s = String(value);
  return s.length > MAX_DISPLAY ? `${s.slice(0, MAX_DISPLAY)}…` : s;
}
