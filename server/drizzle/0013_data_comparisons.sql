CREATE TABLE "data_comparisons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"left_environment_id" uuid NOT NULL,
	"right_environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"outcome" text DEFAULT 'PASS' NOT NULL,
	"options" jsonb NOT NULL,
	"totals" jsonb,
	"progress_message" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_comparison_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_comparison_id" uuid NOT NULL,
	"left_table" text NOT NULL,
	"right_table" text NOT NULL,
	"display_name" text NOT NULL,
	"outcome" text NOT NULL,
	"left_count" integer,
	"right_count" integer,
	"left_truncated" boolean DEFAULT false NOT NULL,
	"right_truncated" boolean DEFAULT false NOT NULL,
	"totals" jsonb NOT NULL,
	"compared_fields" jsonb NOT NULL,
	"fields_only_in_left" jsonb NOT NULL,
	"fields_only_in_right" jsonb NOT NULL,
	"checks" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_comparison_differences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_comparison_id" uuid NOT NULL,
	"left_table" text NOT NULL,
	"key_value" text NOT NULL,
	"difference_type" text NOT NULL,
	"field" text,
	"left_value" text,
	"right_value" text
);
--> statement-breakpoint
ALTER TABLE "data_comparisons" ADD CONSTRAINT "data_comparisons_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_comparisons" ADD CONSTRAINT "data_comparisons_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_comparisons" ADD CONSTRAINT "data_comparisons_left_environment_id_environments_id_fk" FOREIGN KEY ("left_environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_comparisons" ADD CONSTRAINT "data_comparisons_right_environment_id_environments_id_fk" FOREIGN KEY ("right_environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_comparisons" ADD CONSTRAINT "data_comparisons_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_comparison_tables" ADD CONSTRAINT "data_comparison_tables_data_comparison_id_data_comparisons_id_fk" FOREIGN KEY ("data_comparison_id") REFERENCES "public"."data_comparisons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_comparison_differences" ADD CONSTRAINT "data_comparison_differences_data_comparison_id_data_comparisons_id_fk" FOREIGN KEY ("data_comparison_id") REFERENCES "public"."data_comparisons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_comparisons_project_idx" ON "data_comparisons" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "data_comparisons_org_idx" ON "data_comparisons" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "data_comparison_tables_run_idx" ON "data_comparison_tables" USING btree ("data_comparison_id");--> statement-breakpoint
CREATE INDEX "data_comparison_differences_run_idx" ON "data_comparison_differences" USING btree ("data_comparison_id","left_table");
