-- Give every evaluator their own copy of the simulated data.
--
-- `demo_records` was keyed by environment alone, so all demo users shared one set of simulated
-- Dataverse and SQL Server rows: a prospect migrating into the simulated UAT left records sitting
-- there for the next prospect to find. The environments that read this table already belong to an
-- organization, so that becomes the partition key — the boundary every other table already uses.
--
-- The existing rows cannot be assigned an owner, because under the old model they had none: they
-- belonged to whoever happened to be signed in. They are deleted rather than guessed at. This is
-- safe and reversible in the only sense that matters here: every row is a fixture generated from
-- code, and the next sign-in rebuilds a fresh copy for that workspace.
DELETE FROM "demo_records";
--> statement-breakpoint
ALTER TABLE "demo_records" DROP CONSTRAINT "demo_records_environment_key_logical_name_record_id_pk";
--> statement-breakpoint
ALTER TABLE "demo_records" ADD COLUMN "organization_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "demo_records" ADD CONSTRAINT "demo_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "demo_records" ADD CONSTRAINT "demo_records_organization_id_environment_key_logical_name_record_id_pk" PRIMARY KEY("organization_id","environment_key","logical_name","record_id");
--> statement-breakpoint
-- Projects in demo organizations describe migrations whose simulated source and target rows have
-- just been removed, so their runs and validation reports now refer to data that is not there.
-- Archived, not deleted: the history stays readable behind "Show archived", and the two worked
-- examples are rebuilt against fresh data on the next sign-in. Real organizations are untouched —
-- `is_demo` is the whole point of this predicate.
UPDATE "projects" SET "status" = 'ARCHIVED', "updated_at" = now()
WHERE "status" = 'ACTIVE'
  AND "organization_id" IN (SELECT "id" FROM "organizations" WHERE "is_demo" = true);
