import type { MatchStrategy } from '../../../shared/domain';

/** Immutable copy of the plan taken when a run starts, so later plan edits never alter a run. */
export interface RunPlanSnapshot {
  entities: {
    logicalName: string;
    displayName: string;
    orderIndex: number;
    matchStrategy: MatchStrategy;
    alternateKey: string | null;
    mappings: { sourceField: string; targetField: string; isLookup: boolean; deferredTargets: string[] }[];
    /** Source audit columns available for ownership/audit preservation. */
    audit: {
      ownerField: string | null;
      createdOnField: string | null;
      createdByField: string | null;
      modifiedByField: string | null;
      /** Target column that accepts a backdated creation timestamp. */
      overriddenCreatedOnField: string | null;
      /** Mapped target column used to re-stamp modifiedby in pass 3. */
      touchField: { source: string; target: string } | null;
    };
  }[];
}
