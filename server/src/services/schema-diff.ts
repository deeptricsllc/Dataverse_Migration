import type {
  ColumnDiff,
  ComparisonSummary,
  DiffStatus,
  KeyDiff,
  PropertyDifference,
  RelationshipDiff,
  TableDiff,
} from '../../../shared/domain';
import type { AttributeMeta, TableMetadata, TableSummary } from '../../../shared/metadata';
import { typeCompatibility } from './type-compat';

const REQUIRED_RANK: Record<string, number> = {
  None: 0,
  Recommended: 0,
  ApplicationRequired: 1,
  SystemRequired: 1,
};

const emptyCounts = (): Record<DiffStatus, number> => ({
  MATCH: 0,
  SOURCE_ONLY: 0,
  TARGET_ONLY: 0,
  DIFFERENT: 0,
  INCOMPATIBLE: 0,
});

/** Columns that are not meaningful to compare (computed name/yomi shadows of lookups etc.). */
function comparableAttributes(table: TableMetadata): AttributeMeta[] {
  return table.attributes.filter((a) => !a.attributeOf && a.type !== 'Virtual' && a.type !== 'EntityName');
}

export function diffColumn(source: AttributeMeta | undefined, target: AttributeMeta | undefined): ColumnDiff {
  const base = source ?? target!;
  const diff: ColumnDiff = {
    logicalName: base.logicalName,
    displayName: base.displayName,
    status: 'MATCH',
    sourceType: source?.type ?? null,
    targetType: target?.type ?? null,
    sourceRequired: source?.requiredLevel ?? null,
    targetRequired: target?.requiredLevel ?? null,
    differences: [],
  };
  if (!source) return { ...diff, status: 'TARGET_ONLY' };
  if (!target) return { ...diff, status: 'SOURCE_ONLY' };

  const push = (d: PropertyDifference) => diff.differences.push(d);

  const compat = typeCompatibility(source, target);
  if (source.type !== target.type) {
    push({
      property: 'type',
      source: source.type,
      target: target.type,
      breaking: !compat.compatible,
      note: compat.note,
    });
  }
  if (!compat.compatible) {
    diff.status = 'INCOMPATIBLE';
    if (source.type === target.type) {
      push({ property: 'lookupTargets', source: source.targets, target: target.targets, breaking: true, note: compat.note });
    }
    return diff;
  }

  if (REQUIRED_RANK[source.requiredLevel] !== REQUIRED_RANK[target.requiredLevel]) {
    const stricter = REQUIRED_RANK[target.requiredLevel] > REQUIRED_RANK[source.requiredLevel];
    push({
      property: 'requiredLevel',
      source: source.requiredLevel,
      target: target.requiredLevel,
      breaking: stricter,
      note: stricter ? 'Target requires a value; source records without one will be rejected' : undefined,
    });
  }
  if ((source.maxLength ?? null) !== (target.maxLength ?? null) && source.maxLength != null && target.maxLength != null) {
    const shorter = target.maxLength < source.maxLength;
    push({
      property: 'maxLength',
      source: source.maxLength,
      target: target.maxLength,
      breaking: shorter,
      note: shorter ? `Values longer than ${target.maxLength} characters will be rejected` : undefined,
    });
  }
  if (source.precision != null && target.precision != null && source.precision !== target.precision) {
    const lower = target.precision < source.precision;
    push({
      property: 'precision',
      source: source.precision,
      target: target.precision,
      breaking: false,
      note: lower ? 'Values will be rounded to target precision' : undefined,
    });
  }
  if (source.type === 'DateTime' && (source.dateTimeBehavior ?? null) !== (target.dateTimeBehavior ?? null)) {
    push({
      property: 'dateTimeBehavior',
      source: source.dateTimeBehavior,
      target: target.dateTimeBehavior,
      breaking: false,
      note: 'Date/time interpretation differs between environments',
    });
  }
  if (source.targets && target.targets && compat.compatible && compat.lossy && compat.note) {
    push({ property: 'lookupTargets', source: source.targets, target: target.targets, breaking: false, note: compat.note });
  }
  if (source.options || target.options) {
    const so = new Map((source.options ?? []).map((o) => [o.value, o]));
    const to = new Map((target.options ?? []).map((o) => [o.value, o]));
    const sourceOnly = [...so.values()].filter((o) => !to.has(o.value));
    const targetOnly = [...to.values()].filter((o) => !so.has(o.value));
    const labelChanged = [...so.values()].filter((o) => to.has(o.value) && to.get(o.value)!.label !== o.label).map((o) => o.value);
    if (sourceOnly.length || targetOnly.length || labelChanged.length) {
      diff.optionDiff = { sourceOnly, targetOnly, labelChanged };
      push({
        property: 'options',
        source: sourceOnly.map((o) => `${o.value}:${o.label}`),
        target: targetOnly.map((o) => `${o.value}:${o.label}`),
        breaking: sourceOnly.length > 0,
        note:
          sourceOnly.length > 0
            ? `Choice values ${sourceOnly.map((o) => o.value).join(', ')} do not exist in target`
            : labelChanged.length
              ? 'Choice labels differ'
              : 'Target defines additional choice values',
      });
    }
  }
  if (diff.differences.length > 0) diff.status = 'DIFFERENT';
  return diff;
}

function relationshipKey(r: { referencingAttribute: string; referencedEntity: string }) {
  return `${r.referencingAttribute}->${r.referencedEntity}`;
}

export function diffRelationships(source: TableMetadata, target: TableMetadata): RelationshipDiff[] {
  const s = new Map(source.manyToOne.map((r) => [relationshipKey(r), r]));
  const t = new Map(target.manyToOne.map((r) => [relationshipKey(r), r]));
  const keys = [...new Set([...s.keys(), ...t.keys()])].sort();
  return keys.map((k) => {
    const sr = s.get(k);
    const tr = t.get(k);
    const base = (sr ?? tr)!;
    const differences: PropertyDifference[] = [];
    let status: DiffStatus = 'MATCH';
    if (!tr) status = 'SOURCE_ONLY';
    else if (!sr) status = 'TARGET_ONLY';
    else if (sr.referencedAttribute !== tr.referencedAttribute) {
      status = 'DIFFERENT';
      differences.push({
        property: 'referencedAttribute',
        source: sr.referencedAttribute,
        target: tr.referencedAttribute,
        breaking: false,
      });
    }
    return {
      schemaName: base.schemaName,
      status,
      referencingAttribute: base.referencingAttribute,
      sourceTarget: sr?.referencedEntity ?? null,
      targetTarget: tr?.referencedEntity ?? null,
      differences,
    };
  });
}

export function diffKeys(source: TableMetadata, target: TableMetadata): KeyDiff[] {
  const s = new Map(source.keys.map((k) => [k.logicalName, k]));
  const t = new Map(target.keys.map((k) => [k.logicalName, k]));
  const names = [...new Set([...s.keys(), ...t.keys()])].sort();
  return names.map((name) => {
    const sk = s.get(name);
    const tk = t.get(name);
    const sa = sk ? [...sk.attributes].sort() : null;
    const ta = tk ? [...tk.attributes].sort() : null;
    let status: DiffStatus = 'MATCH';
    if (!tk) status = 'SOURCE_ONLY';
    else if (!sk) status = 'TARGET_ONLY';
    else if (sa!.join(',') !== ta!.join(',')) status = 'DIFFERENT';
    return { logicalName: name, status, sourceAttributes: sa, targetAttributes: ta };
  });
}

export function diffTableDeep(source: TableMetadata, target: TableMetadata): TableDiff {
  const sAttrs = new Map(comparableAttributes(source).map((a) => [a.logicalName, a]));
  const tAttrs = new Map(comparableAttributes(target).map((a) => [a.logicalName, a]));
  const names = [...new Set([...sAttrs.keys(), ...tAttrs.keys()])].sort();
  const columns = names.map((n) => diffColumn(sAttrs.get(n), tAttrs.get(n)));
  const relationships = diffRelationships(source, target);
  const keys = diffKeys(source, target);

  const differences: PropertyDifference[] = [];
  if (source.primaryIdAttribute !== target.primaryIdAttribute) {
    differences.push({
      property: 'primaryIdAttribute',
      source: source.primaryIdAttribute,
      target: target.primaryIdAttribute,
      breaking: true,
    });
  }
  if (source.primaryNameAttribute !== target.primaryNameAttribute) {
    differences.push({
      property: 'primaryNameAttribute',
      source: source.primaryNameAttribute,
      target: target.primaryNameAttribute,
      breaking: false,
    });
  }
  if (source.entitySetName !== target.entitySetName) {
    differences.push({ property: 'entitySetName', source: source.entitySetName, target: target.entitySetName, breaking: false });
  }
  if (source.ownershipType !== target.ownershipType) {
    differences.push({ property: 'ownershipType', source: source.ownershipType, target: target.ownershipType, breaking: false });
  }

  const counts = emptyCounts();
  for (const c of columns) counts[c.status]++;

  let status: DiffStatus = 'MATCH';
  const anyDifferent =
    differences.length > 0 ||
    columns.some((c) => c.status !== 'MATCH') ||
    relationships.some((r) => r.status !== 'MATCH') ||
    keys.some((k) => k.status !== 'MATCH');
  if (anyDifferent) status = 'DIFFERENT';
  if (differences.some((d) => d.breaking) || counts.INCOMPATIBLE > 0) status = 'INCOMPATIBLE';

  return {
    logicalName: source.logicalName,
    displayName: source.displayName,
    status,
    isCustom: source.isCustom,
    deep: true,
    differences,
    columns,
    relationships,
    keys,
    counts,
  };
}

export function diffTableShallow(source: TableSummary | undefined, target: TableSummary | undefined): TableDiff {
  const base = (source ?? target)!;
  const status: DiffStatus = !target ? 'SOURCE_ONLY' : !source ? 'TARGET_ONLY' : 'MATCH';
  const differences: PropertyDifference[] = [];
  if (source && target && source.primaryIdAttribute !== target.primaryIdAttribute) {
    differences.push({
      property: 'primaryIdAttribute',
      source: source.primaryIdAttribute,
      target: target.primaryIdAttribute,
      breaking: true,
    });
  }
  return {
    logicalName: base.logicalName,
    displayName: base.displayName,
    status: differences.length ? 'INCOMPATIBLE' : status,
    isCustom: base.isCustom,
    deep: false,
    differences,
    columns: [],
    relationships: [],
    keys: [],
    counts: emptyCounts(),
  };
}

/**
 * Compares two environments. Table catalogs are compared in full; tables present in `deep`
 * on both sides are compared column by column.
 */
export function compareSchemas(input: {
  sourceCatalog: TableSummary[];
  targetCatalog: TableSummary[];
  sourceDeep: Map<string, TableMetadata>;
  targetDeep: Map<string, TableMetadata>;
}): { tables: TableDiff[]; summary: ComparisonSummary } {
  const s = new Map(input.sourceCatalog.map((t) => [t.logicalName, t]));
  const t = new Map(input.targetCatalog.map((x) => [x.logicalName, x]));
  const names = [...new Set([...s.keys(), ...t.keys()])].sort();
  const tables: TableDiff[] = names.map((name) => {
    const sd = input.sourceDeep.get(name);
    const td = input.targetDeep.get(name);
    if (sd && td) return diffTableDeep(sd, td);
    return diffTableShallow(s.get(name), t.get(name));
  });
  return { tables, summary: summarize(tables) };
}

export function summarize(tables: TableDiff[]): ComparisonSummary {
  return {
    tablesCompared: tables.length,
    deepCompared: tables.filter((x) => x.deep).length,
    match: tables.filter((x) => x.status === 'MATCH').length,
    different: tables.filter((x) => x.status === 'DIFFERENT').length,
    sourceOnly: tables.filter((x) => x.status === 'SOURCE_ONLY').length,
    targetOnly: tables.filter((x) => x.status === 'TARGET_ONLY').length,
    incompatible: tables.filter((x) => x.status === 'INCOMPATIBLE').length,
    columnDifferences: tables.reduce(
      (n, x) => n + x.columns.filter((c) => c.status !== 'MATCH').length,
      0,
    ),
  };
}
