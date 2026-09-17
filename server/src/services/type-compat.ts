import type { AttributeMeta, AttributeType } from '../../../shared/metadata';

export type Compatibility =
  { compatible: true; lossy: boolean; note?: string } | { compatible: false; note: string };

const NUMERIC: ReadonlySet<AttributeType> = new Set(['Integer', 'BigInt', 'Decimal', 'Double', 'Money']);
const TEXT: ReadonlySet<AttributeType> = new Set(['String', 'Memo']);
const LOOKUP: ReadonlySet<AttributeType> = new Set(['Lookup', 'Customer', 'Owner']);
const WIDENING: Record<string, AttributeType[]> = {
  Integer: ['BigInt', 'Decimal', 'Double', 'Money'],
  BigInt: ['Decimal', 'Double'],
  Decimal: ['Double', 'Money'],
  Money: ['Decimal', 'Double'],
};

/** Deterministic compatibility between a source and target Dataverse column type. */
export function typeCompatibility(source: AttributeMeta, target: AttributeMeta): Compatibility {
  const s = source.type;
  const t = target.type;
  if (LOOKUP.has(s) && LOOKUP.has(t)) {
    const st = source.targets ?? [];
    const tt = new Set(target.targets ?? []);
    const missing = st.filter((x) => !tt.has(x));
    if (st.length > 0 && missing.length === st.length) {
      return { compatible: false, note: `Target lookup does not reference ${missing.join(', ')}` };
    }
    if (missing.length > 0) {
      return { compatible: true, lossy: true, note: `Target lookup cannot reference ${missing.join(', ')}` };
    }
    return { compatible: true, lossy: s !== t && t !== 'Customer' && s === 'Customer' };
  }
  if (s === t) return { compatible: true, lossy: false };
  if (TEXT.has(s) && TEXT.has(t)) {
    return {
      compatible: true,
      lossy: s === 'Memo',
      note: s === 'Memo' ? 'Multiline text into single line' : undefined,
    };
  }
  if (NUMERIC.has(s) && NUMERIC.has(t)) {
    const widening = WIDENING[s]?.includes(t) ?? false;
    return {
      compatible: true,
      lossy: !widening,
      note: widening ? undefined : `${s} to ${t} may lose precision`,
    };
  }
  if ((s === 'State' || s === 'Status') && (t === 'State' || t === 'Status')) {
    return { compatible: false, note: 'State and status reason are distinct columns' };
  }
  return { compatible: false, note: `${s} cannot be converted to ${t}` };
}

export function isLookupType(t: AttributeType | null | undefined): boolean {
  return !!t && LOOKUP.has(t);
}
