import type { TypeCompatibility } from '../../../shared/domain';
import type { AttributeMeta } from '../../../shared/metadata';
import { classifyCrossProviderCompatibility } from '../connectors/sql/type-map';
import { typeCompatibility } from './type-compat';

/**
 * One verdict for a source column mapped onto a target column, whichever providers they belong to.
 *
 * Same-provider mappings keep the established Dataverse rules; cross-provider mappings go through
 * the SQL/Dataverse classifier, which understands the conversions that only exist between systems
 * (text into a choice, an integer key into a lookup, a wider column into a narrower one).
 */
export function fieldVerdict(source: AttributeMeta, target: AttributeMeta | undefined): TypeCompatibility {
  if (!target) return 'INCOMPATIBLE';
  const crossProvider = Boolean(source.sql) !== Boolean(target.sql);
  if (crossProvider) return classifyCrossProviderCompatibility(source, target).status;
  const compat = typeCompatibility(source, target);
  if (!compat.compatible) return 'INCOMPATIBLE';
  return compat.lossy ? 'LOSSY' : 'COMPATIBLE';
}

/** A human-readable reason for {@link fieldVerdict}, used in the mapping UI and exports. */
export function fieldVerdictReason(source: AttributeMeta, target: AttributeMeta | undefined): string {
  if (!target) return 'No target column is mapped';
  const crossProvider = Boolean(source.sql) !== Boolean(target.sql);
  if (crossProvider) return classifyCrossProviderCompatibility(source, target).reason;
  const compat = typeCompatibility(source, target);
  if (!compat.compatible) return compat.note;
  return compat.note ?? `${source.type} → ${target.type}`;
}

/** True when the mapping needs a choice mapping before it can run. */
export function needsChoiceMapping(source: AttributeMeta, target: AttributeMeta | undefined): boolean {
  if (!target) return false;
  const choiceTarget = target.type === 'Picklist' || target.type === 'State' || target.type === 'Status';
  if (!choiceTarget) return false;
  // A choice into the same choice is a straight value copy; anything else needs a value map.
  return source.type !== target.type || Boolean(source.sql);
}
