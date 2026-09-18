/**
 * Pairs a source table with the target table it migrates into.
 *
 * Within one provider the names normally match exactly and the pairing is obvious. Across
 * providers they almost never match (`dbo.Customer` is `account`), so this module proposes
 * candidates and says how confident it is — but a non-exact pairing is only ever a SUGGESTION.
 * Nothing migrates until a person confirms it, because migrating one table's rows into the wrong
 * table is not a mistake you can quietly undo.
 */
import type { ObjectMappingStatus } from '../../../shared/domain';
import type { TableMetadata, TableSummary } from '../../../shared/metadata';

export interface ObjectCandidate {
  logicalName: string;
  displayName: string;
  /** 0-100. 100 means the names are identical. */
  confidence: number;
  reason: string;
}

export interface ObjectMappingProposal {
  targetLogicalName: string | null;
  targetDisplayName: string | null;
  status: ObjectMappingStatus;
  candidates: ObjectCandidate[];
}

/** Common legacy-to-Dataverse table names. Used as a hint, never applied on its own. */
const SYNONYMS: Record<string, string[]> = {
  customer: ['account', 'contact'],
  client: ['account'],
  company: ['account'],
  organisation: ['account'],
  organization: ['account'],
  person: ['contact'],
  people: ['contact'],
  contact: ['contact'],
  order: ['salesorder'],
  salesorder: ['salesorder'],
  orderline: ['salesorderdetail'],
  orderdetail: ['salesorderdetail'],
  product: ['product'],
  item: ['product'],
  region: ['dtx_region', 'territory'],
  territory: ['territory', 'dtx_region'],
  office: ['dtx_office'],
  setting: ['dtx_applicationconfig'],
  applicationsetting: ['dtx_applicationconfig'],
  config: ['dtx_applicationconfig'],
  configuration: ['dtx_applicationconfig'],
};

/** `dbo.Customer` -> `customer`; `dtx_region` -> `region`; `Sales_Orders` -> `salesorder`. */
export function normalizeTableName(logicalName: string): string {
  const withoutSchema = logicalName.includes('.') ? logicalName.split('.').slice(1).join('.') : logicalName;
  const withoutPublisher = withoutSchema.replace(/^[a-z0-9]{2,8}_/i, '');
  const base = withoutPublisher.replace(/[^a-z0-9]/gi, '').toLowerCase();
  // Singularize the common plural forms so `Customers` and `Customer` compare equal.
  if (base.endsWith('ies')) return `${base.slice(0, -3)}y`;
  if (base.endsWith('sses') || base.endsWith('ches') || base.endsWith('shes')) return base.slice(0, -2);
  if (base.endsWith('s') && !base.endsWith('ss')) return base.slice(0, -1);
  return base;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length, 1);
}

/**
 * Proposes the target table for one source table.
 *
 * An identical logical name is EXACT and is used immediately, which is what keeps same-provider
 * migrations working exactly as before. Anything else comes back as AUTO_SUGGESTED (or UNMAPPED)
 * and is treated as a blocker by plan validation until a person confirms it.
 */
export function proposeObjectMapping(
  source: TableSummary | TableMetadata,
  targetCatalog: TableSummary[],
): ObjectMappingProposal {
  const exact = targetCatalog.find((t) => t.logicalName === source.logicalName);
  if (exact) {
    return {
      targetLogicalName: exact.logicalName,
      targetDisplayName: exact.displayName,
      status: 'EXACT',
      candidates: [],
    };
  }

  const sourceKey = normalizeTableName(source.logicalName);
  const synonyms = new Set(SYNONYMS[sourceKey] ?? []);
  const scored = targetCatalog
    // A view or an intersect table is never a migration target.
    .filter((t) => !t.isView && !t.isIntersect)
    .map((t) => {
      const targetKey = normalizeTableName(t.logicalName);
      let score = similarity(sourceKey, targetKey);
      let reason = `Name similarity ${Math.round(score * 100)}% (${source.displayName} ~ ${t.displayName})`;
      if (synonyms.has(t.logicalName) || synonyms.has(targetKey)) {
        score = Math.max(score, 0.8);
        reason = `${source.displayName} is a common legacy name for ${t.displayName}`;
      }
      return {
        logicalName: t.logicalName,
        displayName: t.displayName,
        confidence: Math.round(score * 100),
        reason,
      };
    })
    .filter((c) => c.confidence >= 55)
    .sort((a, b) => b.confidence - a.confidence || a.logicalName.localeCompare(b.logicalName))
    .slice(0, 5);

  if (scored.length === 0) {
    return { targetLogicalName: null, targetDisplayName: null, status: 'UNMAPPED', candidates: [] };
  }
  return {
    targetLogicalName: scored[0].logicalName,
    targetDisplayName: scored[0].displayName,
    // Deliberately not CONFIRMED: a similar name is not evidence that the data belongs there.
    status: 'AUTO_SUGGESTED',
    candidates: scored,
  };
}
