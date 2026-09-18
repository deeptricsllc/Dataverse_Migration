import type {
  ChoiceMappingDto,
  FieldTransformDto,
  MatchStrategy,
  TransformationRule,
} from '../../../shared/domain';

/** Immutable copy of the plan taken when a run starts, so later plan edits never alter a run. */
export interface RunPlanSnapshot {
  entities: {
    /** Source table. */
    logicalName: string;
    displayName: string;
    /** Target table this source table migrates into (same name for same-provider plans). */
    targetLogicalName: string;
    orderIndex: number;
    matchStrategy: MatchStrategy;
    alternateKey: string | null;
    /** Columns forming the configured business key (MatchStrategy BUSINESS_KEY). */
    businessKeyFields: string[];
    mappings: {
      sourceField: string;
      targetField: string;
      isLookup: boolean;
      deferredTargets: string[];
      /**
       * The ordered transformation pipeline, copied when the run started. A later edit to the
       * plan cannot change what this run did, so validating it years later is still deterministic.
       */
      transformations?: TransformationRule[] | null;
      /** Single-step transformation from plans that predate pipelines. */
      transform?: FieldTransformDto | null;
      /** Value map for a choice target (SQL text into a Dataverse option, for example). */
      choiceMap?: ChoiceMappingDto | null;
    }[];
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
