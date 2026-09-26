CREATE TABLE "analysis_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_run_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"field" text,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"affected" integer DEFAULT 0 NOT NULL,
	"basis" text DEFAULT 'SAMPLED' NOT NULL,
	"resolution" text
);
--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"options" jsonb NOT NULL,
	"totals" jsonb,
	"basis" text,
	"progress_message" text,
	"error_message" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analysis_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_run_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"display_name" text NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"record_count_approximate" boolean DEFAULT false NOT NULL,
	"column_count" integer DEFAULT 0 NOT NULL,
	"examined" integer DEFAULT 0 NOT NULL,
	"basis" text DEFAULT 'SAMPLED' NOT NULL,
	"blockers" integer DEFAULT 0 NOT NULL,
	"warnings" integer DEFAULT 0 NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"empty_columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_key_field" text,
	"duplicate_key_count" integer DEFAULT 0 NOT NULL,
	"profile" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"mode" text DEFAULT 'FULL' NOT NULL,
	"watermark_field" text,
	"last_watermark" text,
	"confirm_source_name" text NOT NULL,
	"confirm_target_name" text NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_run_id" uuid,
	"last_status" text,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"paused_reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"source_environment_id" uuid,
	"target_environment_id" uuid,
	"analysis_project_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "migration_plans" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD COLUMN "trigger" text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD COLUMN "watermark" text;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD COLUMN "incremental" jsonb;--> statement-breakpoint
ALTER TABLE "analysis_findings" ADD CONSTRAINT "analysis_findings_analysis_run_id_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_tables" ADD CONSTRAINT "analysis_tables_analysis_run_id_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_schedules" ADD CONSTRAINT "migration_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_schedules" ADD CONSTRAINT "migration_schedules_plan_id_migration_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."migration_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_schedules" ADD CONSTRAINT "migration_schedules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_environment_id_environments_id_fk" FOREIGN KEY ("source_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_target_environment_id_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_findings_run_idx" ON "analysis_findings" USING btree ("analysis_run_id","severity");--> statement-breakpoint
CREATE INDEX "analysis_runs_project_idx" ON "analysis_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_tables_run_name_idx" ON "analysis_tables" USING btree ("analysis_run_id","logical_name");--> statement-breakpoint
CREATE INDEX "migration_schedules_due_idx" ON "migration_schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "migration_schedules_plan_idx" ON "migration_schedules" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "projects_org_kind_idx" ON "projects" USING btree ("organization_id","kind","created_at");--> statement-breakpoint
ALTER TABLE "migration_plans" ADD CONSTRAINT "migration_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;