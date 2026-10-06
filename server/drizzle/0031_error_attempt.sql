-- Which attempt of the run recorded a failure.
--
-- Nullable on purpose. Rows written before this column cannot be attributed to an attempt, and a
-- default of 1 would state something nobody recorded -- in the one place a person goes to see what
-- changed between attempts. Those rows read "Not recorded".
ALTER TABLE "migration_errors" ADD COLUMN IF NOT EXISTS "run_attempt" integer;
--> statement-breakpoint
-- The failure list filters by attempt and by cause, over a run that may hold millions of rows.
CREATE INDEX IF NOT EXISTS "migration_errors_attempt_idx" ON "migration_errors" ("run_id","run_attempt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "migration_errors_code_idx" ON "migration_errors" ("run_id","error_code");
