import type { AttributeMeta, TableMetadata } from '../../shared/metadata';

export function attr(
  logicalName: string,
  type: AttributeMeta['type'],
  extra: Partial<AttributeMeta> = {},
): AttributeMeta {
  return {
    logicalName,
    schemaName: logicalName,
    displayName: logicalName,
    type,
    rawType: type,
    requiredLevel: 'None',
    isPrimaryId: false,
    isPrimaryName: false,
    isCustom: false,
    isValidForCreate: true,
    isValidForUpdate: true,
    isValidForRead: true,
    ...extra,
  };
}

export function table(
  logicalName: string,
  attributes: AttributeMeta[],
  extra: Partial<TableMetadata> = {},
): TableMetadata {
  const pk = attr(`${logicalName}id`, 'Uniqueidentifier', { isPrimaryId: true, isValidForUpdate: false });
  return {
    logicalName,
    schemaName: logicalName,
    displayName: logicalName,
    entitySetName: `${logicalName}s`,
    primaryIdAttribute: pk.logicalName,
    primaryNameAttribute: 'name',
    isCustom: false,
    ownershipType: 'UserOwned',
    isIntersect: false,
    isActivity: false,
    attributes: [pk, ...attributes],
    manyToOne: attributes
      .filter((a) => a.targets)
      .flatMap((a) =>
        a.targets!.map((t) => ({
          schemaName: `${logicalName}_${a.logicalName}_${t}`,
          type: 'ManyToOne' as const,
          referencingEntity: logicalName,
          referencingAttribute: a.logicalName,
          referencedEntity: t,
          referencedAttribute: `${t}id`,
          navigationProperty: a.logicalName,
          isCustom: false,
        })),
      ),
    manyToMany: [],
    keys: [],
    ...extra,
  };
}

export const lookup = (name: string, targets: string[], required = false) =>
  attr(name, 'Lookup', { targets, requiredLevel: required ? 'ApplicationRequired' : 'None' });
