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
  }[];
}
