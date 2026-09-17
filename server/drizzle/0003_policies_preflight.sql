CREATE TABLE "preflight_entity_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preflight_run_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"display_name" text NOT NULL,
	"match_description" text NOT NULL,
	"sampled" boolean DEFAULT false NOT NULL,
	"totals" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preflight_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preflight_run_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"source_record_id" text NOT NULL,
	"record_name" text,
	"action" text NOT NULL,
	"target_record_id" text,
	"match_method" text,
	"reason_code" text,
	"reason" text,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preflight_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"source_environment_id" uuid NOT NULL,
	"target_environment_id" uuid NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"options" jsonb NOT NULL,
	"totals" jsonb,
	"identity_impact" jsonb,
	"progress_message" text,
	"error_message" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "migration_plan_entities" ADD COLUMN "business_key_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_record_maps" ADD COLUMN "principal_fallbacks" jsonb;--> statement-breakpoint
ALTER TABLE "principal_maps" ADD COLUMN "candidates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "preflight_entity_results" ADD CONSTRAINT "preflight_entity_results_preflight_run_id_preflight_runs_id_fk" FOREIGN KEY ("preflight_run_id") REFERENCES "public"."preflight_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preflight_records" ADD CONSTRAINT "preflight_records_preflight_run_id_preflight_runs_id_fk" FOREIGN KEY ("preflight_run_id") REFERENCES "public"."preflight_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preflight_runs" ADD CONSTRAINT "preflight_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preflight_runs" ADD CONSTRAINT "preflight_runs_plan_id_migration_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."migration_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preflight_runs" ADD CONSTRAINT "preflight_runs_source_environment_id_environments_id_fk" FOREIGN KEY ("source_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preflight_runs" ADD CONSTRAINT "preflight_runs_target_environment_id_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preflight_runs" ADD CONSTRAINT "preflight_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "preflight_entity_results_uq" ON "preflight_entity_results" USING btree ("preflight_run_id","logical_name");--> statement-breakpoint
CREATE INDEX "preflight_records_run_idx" ON "preflight_records" USING btree ("preflight_run_id","action");--> statement-breakpoint
CREATE INDEX "preflight_records_entity_idx" ON "preflight_records" USING btree ("preflight_run_id","logical_name","action");--> statement-breakpoint
CREATE INDEX "preflight_runs_plan_idx" ON "preflight_runs" USING btree ("plan_id","created_at");