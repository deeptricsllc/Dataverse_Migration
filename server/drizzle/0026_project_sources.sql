-- An analysis project has many sources.
--
-- "What is in my data" is rarely a question about one system. It is four Excel workbooks, or a SQL Server
-- and a spreadsheet of corrections, or two Dataverse environments. The single
-- `projects.source_environment_id` column could only ever express one, which forced a separate project per
-- dataset and made a cross-source observation impossible to even ask for.
--
-- `projects.source_environment_id` is kept, and stays in step with the first source, because analysis runs,
-- migration projects and comparison projects all still read it and a migration's source is genuinely one
-- thing. This table is the list; that column is the primary entry in it.
--
-- `environment_id` cascades on delete and `project_id` cascades on delete, in that order of importance:
-- removing a source from a project must never delete the reusable connection, so nothing here deletes an
-- environment. Deleting an environment that a project still lists removes only the listing.
CREATE TABLE IF NOT EXISTS "project_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"environment_id" uuid NOT NULL REFERENCES "environments"("id") ON DELETE CASCADE,
	"position" integer DEFAULT 0 NOT NULL,
	"added_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- One listing per source per project. Adding the same dataset twice is a mistake, not a configuration.
CREATE UNIQUE INDEX IF NOT EXISTS "project_sources_project_env_uq" ON "project_sources" USING btree ("project_id","environment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_sources_project_idx" ON "project_sources" USING btree ("project_id","position");--> statement-breakpoint
-- Backfill, so no existing project loses the source it already had. Position 0: it is the primary one.
INSERT INTO "project_sources" ("project_id", "environment_id", "position") SELECT "id", "source_environment_id", 0 FROM "projects" WHERE "source_environment_id" IS NOT NULL ON CONFLICT DO NOTHING;
