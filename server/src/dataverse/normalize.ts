/**
 * Converts raw Dataverse Web API metadata/record payloads into the normalized model.
 * Pure functions so they can be unit-tested with captured responses.
 */
import {
  ATTRIBUTE_TYPES,
  LOOKUP_TYPES,
  type AlternateKeyMeta,
  type AttributeMeta,
  type AttributeType,
  type DvRecord,
  type FieldValue,
  type OptionMeta,
  type RelationshipMeta,
  type RequiredLevel,
  type TableSummary,
} from '../../../shared/metadata';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const label = (l: Raw | null | undefined, fallback = ''): string =>
  l?.UserLocalizedLabel?.Label ?? l?.LocalizedLabels?.[0]?.Label ?? fallback;

export function normalizeTableSummary(e: Raw): TableSummary {
  return {
    logicalName: e.LogicalName,
    schemaName: e.SchemaName,
    displayName: label(e.DisplayName, e.SchemaName ?? e.LogicalName),
    description: label(e.Description) || undefined,
    entitySetName: e.EntitySetName ?? '',
    primaryIdAttribute: e.PrimaryIdAttribute,
    primaryNameAttribute: e.PrimaryNameAttribute ?? null,
    isCustom: Boolean(e.IsCustomEntity),
    ownershipType: typeof e.OwnershipType === 'string' ? e.OwnershipType : String(e.OwnershipType ?? 'None'),
    isIntersect: Boolean(e.IsIntersect),
    isActivity: Boolean(e.IsActivity),
  };
}

export function normalizeAttributeType(raw: Raw): AttributeType {
  const typeName: string | undefined = raw.AttributeTypeName?.Value;
  const candidate = (typeName ? typeName.replace(/Type$/, '') : raw.AttributeType) as string;
  if (candidate === 'Uniqueidentifier' || candidate === 'UniqueIdentifier') return 'Uniqueidentifier';
  if ((ATTRIBUTE_TYPES as readonly string[]).includes(candidate)) return candidate as AttributeType;
  if (raw.AttributeType === 'PartyList') return 'Other';
  return 'Other';
}

const bool = (v: unknown) => (typeof v === 'object' && v !== null ? Boolean((v as Raw).Value) : Boolean(v));

export function normalizeAttribute(a: Raw, extra: Raw | undefined): AttributeMeta {
  const type = normalizeAttributeType(a);
  const optionSet = extra?.OptionSet ?? extra?.GlobalOptionSet;
  const options: OptionMeta[] | undefined = optionSet?.Options?.map((o: Raw) => ({
    value: o.Value,
    label: label(o.Label, String(o.Value)),
  }));
  return {
    logicalName: a.LogicalName,
    schemaName: a.SchemaName,
    displayName: label(a.DisplayName, a.SchemaName ?? a.LogicalName),
    description: label(a.Description) || undefined,
    type,
    rawType: a.AttributeTypeName?.Value ?? a.AttributeType,
    requiredLevel: (a.RequiredLevel?.Value ?? 'None') as RequiredLevel,
    isPrimaryId: Boolean(a.IsPrimaryId),
    isPrimaryName: Boolean(a.IsPrimaryName),
    isCustom: Boolean(a.IsCustomAttribute),
    isValidForCreate: bool(a.IsValidForCreate),
    isValidForUpdate: bool(a.IsValidForUpdate),
    isValidForRead: bool(a.IsValidForRead),
    isSecured: Boolean(a.IsSecured),
    attributeOf: a.AttributeOf ?? null,
    maxLength: extra?.MaxLength ?? null,
    precision: extra?.Precision ?? null,
    minValue: extra?.MinValue ?? null,
    maxValue: extra?.MaxValue ?? null,
    format: extra?.Format ?? extra?.FormatName?.Value ?? null,
    dateTimeBehavior: extra?.DateTimeBehavior?.Value ?? null,
    options,
    optionSetName: optionSet?.Name ?? null,
    isGlobalOptionSet: optionSet ? Boolean(optionSet.IsGlobal) : undefined,
    targets: LOOKUP_TYPES.has(type) ? (extra?.Targets ?? []) : undefined,
  };
}

export function normalizeManyToOne(r: Raw): RelationshipMeta {
  return {
    schemaName: r.SchemaName,
    type: 'ManyToOne',
    referencingEntity: r.ReferencingEntity,
    referencingAttribute: r.ReferencingAttribute,
    referencedEntity: r.ReferencedEntity,
    referencedAttribute: r.ReferencedAttribute,
    navigationProperty: r.ReferencingEntityNavigationPropertyName ?? null,
    isCustom: Boolean(r.IsCustomRelationship),
  };
}

export function normalizeManyToMany(r: Raw): RelationshipMeta {
  return {
    schemaName: r.SchemaName,
    type: 'ManyToMany',
    referencingEntity: r.Entity1LogicalName,
    referencingAttribute: r.Entity1IntersectAttribute ?? '',
    referencedEntity: r.Entity2LogicalName,
    referencedAttribute: r.Entity2IntersectAttribute ?? '',
    navigationProperty: null,
    isCustom: Boolean(r.IsCustomRelationship),
    intersectEntity: r.IntersectEntityName ?? null,
  };
}

export function normalizeKey(k: Raw): AlternateKeyMeta {
  return {
    logicalName: k.LogicalName,
    schemaName: k.SchemaName,
    displayName: label(k.DisplayName, k.SchemaName ?? k.LogicalName),
    attributes: k.KeyAttributes ?? [],
    status: k.EntityKeyIndexStatus ?? null,
  };
}

const LOOKUP_ANNOTATION = '@Microsoft.Dynamics.CRM.lookuplogicalname';

/** Converts a Web API entity payload into a normalized record. */
export function normalizeRecord(raw: Raw, primaryId: string, attributes: AttributeMeta[]): DvRecord {
  const values: Record<string, FieldValue> = {};
  for (const attr of attributes) {
    if (LOOKUP_TYPES.has(attr.type)) {
      const key = `_${attr.logicalName}_value`;
      const id = raw[key];
      values[attr.logicalName] =
        id == null
          ? null
          : {
              id: String(id).toLowerCase(),
              logicalName: raw[`${key}${LOOKUP_ANNOTATION}`] ?? attr.targets?.[0] ?? '',
            };
      continue;
    }
    const v = raw[attr.logicalName];
    if (v === undefined) continue;
    if (attr.type === 'MultiSelectPicklist' && typeof v === 'string') {
      values[attr.logicalName] = v
        .split(',')
        .filter(Boolean)
        .map((x) => Number(x));
    } else if (attr.type === 'Uniqueidentifier' && typeof v === 'string') {
      values[attr.logicalName] = v.toLowerCase();
    } else {
      values[attr.logicalName] = v as FieldValue;
    }
  }
  return { id: String(raw[primaryId]).toLowerCase(), values };
}

/** Maps Global Discovery OrganizationType to a readable environment type. */
export function organizationTypeName(t: unknown): string | null {
  const map: Record<number, string> = {
    0: 'Production',
    5: 'Sandbox',
    6: 'Sandbox',
    7: 'Preview',
    9: 'Trial',
    11: 'Trial',
    12: 'Default',
    13: 'Developer',
    14: 'Trial',
    15: 'Teams',
  };
  return typeof t === 'number' ? (map[t] ?? `Type ${t}`) : typeof t === 'string' ? t : null;
}
