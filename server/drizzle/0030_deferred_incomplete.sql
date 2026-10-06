-- Records written with a reference the target could not resolve.
--
-- Additive and defaulted, so an upgraded database reads zero for every dataset that ran before this
-- existed. Zero here means "not recorded", not "none omitted"; the UI reads migration_errors for runs
-- that predate the column. See docs/MIGRATION_OUTCOME_SEMANTICS.md.
ALTER TABLE "migration_run_entities" ADD COLUMN IF NOT EXISTS "deferred_incomplete" integer DEFAULT 0 NOT NULL;
