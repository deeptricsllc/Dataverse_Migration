CREATE TABLE "principal_directory" (
	"environment_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"principal_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_directory_environment_id_logical_name_principal_id_pk" PRIMARY KEY("environment_id","logical_name","principal_id")
);
--> statement-breakpoint
CREATE TABLE "principal_maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_environment_id" uuid NOT NULL,
	"target_environment_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text,
	"status" text NOT NULL,
	"match_method" text,
	"confidence" integer DEFAULT 0 NOT NULL,
	"note" text,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "migration_plan_entities" ADD COLUMN "audit" jsonb;--> statement-breakpoint
ALTER TABLE "migration_record_maps" ADD COLUMN "audit_pending" jsonb;--> statement-breakpoint
ALTER TABLE "migration_record_maps" ADD COLUMN "audit_status" text;--> statement-breakpoint
ALTER TABLE "migration_run_entities" ADD COLUMN "unchanged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD COLUMN "unchanged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "principal_directory" ADD CONSTRAINT "principal_directory_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_maps" ADD CONSTRAINT "principal_maps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_maps" ADD CONSTRAINT "principal_maps_source_environment_id_environments_id_fk" FOREIGN KEY ("source_environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_maps" ADD CONSTRAINT "principal_maps_target_environment_id_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_maps" ADD CONSTRAINT "principal_maps_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "principal_maps_uq" ON "principal_maps" USING btree ("source_environment_id","target_environment_id","logical_name","source_id");--> statement-breakpoint
CREATE INDEX "principal_maps_org_idx" ON "principal_maps" USING btree ("organization_id");