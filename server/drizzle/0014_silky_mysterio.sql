-- What the run did with each record, as the run itself recorded it.
--
-- Nullable on purpose: a report written before this column existed did not record the breakdown,
-- and null says so. Backfilling it from the old `migrated_records` column is not possible, because
-- that column counted records the run deliberately did not write as records it had migrated — the
-- very error this column exists to end. Those reports stay as they were, and the application says
-- the breakdown was not recorded rather than inventing one.
ALTER TABLE "validation_entity_results" ADD COLUMN "record_accounting" jsonb;
