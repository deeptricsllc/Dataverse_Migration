-- Which project an audited action belonged to.
--
-- Audit events carried the two environments and, where there was one, the run. That is the vocabulary of
-- the model this product has replaced: when source and target were application-wide, naming them was the
-- only way to say what an action was about. Now that a migration belongs to a project, "which migration
-- was this" is a question the trail could not answer without joining through a plan that may since have
-- been reconfigured.
--
-- Nullable, and deliberately not backfilled. An event recorded before this column existed genuinely did
-- not record a project, and inferring one afterwards would put a guess in the one place in the product
-- that is supposed to contain only what was observed.
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "project_id" uuid;--> statement-breakpoint
-- Reading an audit trail is almost always "what happened in this project", newest first.
CREATE INDEX IF NOT EXISTS "audit_events_project_idx" ON "audit_events" USING btree ("project_id","created_at");
