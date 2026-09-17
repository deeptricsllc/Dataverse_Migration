CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"source_environment_id" uuid,
	"target_environment_id" uuid,
	"run_id" uuid,
	"request_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_requests" (
	"state" text PRIMARY KEY NOT NULL,
	"encrypted_verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"return_to" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comparison_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_environment_id" uuid NOT NULL,
	"target_environment_id" uuid NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"scope" jsonb,
	"refresh_metadata" boolean DEFAULT false NOT NULL,
	"summary" jsonb,
	"progress_message" text,
	"error_message" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "comparison_table_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comparison_run_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"deep" boolean DEFAULT false NOT NULL,
	"differences" jsonb NOT NULL,
	"columns" jsonb NOT NULL,
	"relationships" jsonb NOT NULL,
	"keys" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_records" (
	"environment_key" text NOT NULL,
	"logical_name" text NOT NULL,
	"record_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_records_environment_key_logical_name_record_id_pk" PRIMARY KEY("environment_key","logical_name","record_id")
);
--> statement-breakpoint
CREATE TABLE "environment_access" (
	"user_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_access_user_id_environment_id_pk" PRIMARY KEY("user_id","environment_id")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"url" text NOT NULL,
	"api_url" text,
	"dataverse_organization_id" text,
	"environment_id" text,
	"unique_name" text,
	"environment_type" text,
	"region" text,
	"version" text,
	"state" text,
	"dataverse_available" boolean DEFAULT true NOT NULL,
	"connection_status" text DEFAULT 'UNKNOWN' NOT NULL,
	"connection_message" text,
	"last_tested_at" timestamp with time zone,
	"last_discovered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_entity_id" uuid NOT NULL,
	"source_field" text NOT NULL,
	"source_display_name" text NOT NULL,
	"target_field" text,
	"source_type" text NOT NULL,
	"target_type" text,
	"status" text NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"is_lookup" boolean DEFAULT false NOT NULL,
	"lookup_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"deferred" boolean DEFAULT false NOT NULL,
	"deferred_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"heartbeat_at" timestamp with time zone,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metadata_catalogs" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"tables" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metadata_tables" (
	"environment_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"attribute_count" integer NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metadata_tables_environment_id_logical_name_pk" PRIMARY KEY("environment_id","logical_name")
);
--> statement-breakpoint
CREATE TABLE "migration_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"source_record_id" text,
	"operation" text NOT NULL,
	"severity" text DEFAULT 'ERROR' NOT NULL,
	"error_code" text NOT NULL,
	"message" text NOT NULL,
	"field" text,
	"retryable" boolean DEFAULT false NOT NULL,
	"http_status" integer,
	"attempts" integer DEFAULT 1 NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_plan_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"display_name" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"selected_explicitly" boolean DEFAULT true NOT NULL,
	"source_count" integer,
	"target_count" integer,
	"count_approximate" boolean DEFAULT false NOT NULL,
	"schema_status" text,
	"match_strategy" text DEFAULT 'PRIMARY_ID' NOT NULL,
	"alternate_key" text,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cycle_group" integer,
	"automation" jsonb
);
--> statement-breakpoint
CREATE TABLE "migration_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"source_environment_id" uuid NOT NULL,
	"target_environment_id" uuid NOT NULL,
	"comparison_run_id" uuid,
	"options" jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dependency_analysis" jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_record_maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_environment_id" uuid NOT NULL,
	"target_environment_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text,
	"outcome" text NOT NULL,
	"match_method" text,
	"deferred_lookups" jsonb,
	"deferred_status" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_run_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"display_name" text NOT NULL,
	"order_index" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"deferred_pending" integer DEFAULT 0 NOT NULL,
	"deferred_resolved" integer DEFAULT 0 NOT NULL,
	"deferred_failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "migration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"source_environment_id" uuid NOT NULL,
	"target_environment_id" uuid NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"phase" text,
	"options" jsonb NOT NULL,
	"plan_snapshot" jsonb NOT NULL,
	"current_entity" text,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"pause_requested" boolean DEFAULT false NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error_message" text,
	"executed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"entra_tenant_id" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_entra_tenant_id_unique" UNIQUE("entra_tenant_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_categories" (
	"organization_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"category" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_categories_organization_id_logical_name_pk" PRIMARY KEY("organization_id","logical_name")
);
--> statement-breakpoint
CREATE TABLE "token_caches" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_cache" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"source_environment_id" uuid,
	"target_environment_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"auth_provider" text NOT NULL,
	"email" text,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'MEMBER' NOT NULL,
	"msal_home_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "validation_differences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"validation_run_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"source_record_id" text,
	"target_record_id" text,
	"field" text,
	"source_value" text,
	"target_value" text,
	"difference_type" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validation_entity_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"validation_run_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"display_name" text NOT NULL,
	"outcome" text NOT NULL,
	"source_count" integer,
	"target_count" integer,
	"migrated_records" integer DEFAULT 0 NOT NULL,
	"checked_records" integer DEFAULT 0 NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"missing" integer DEFAULT 0 NOT NULL,
	"different" integer DEFAULT 0 NOT NULL,
	"broken_references" integer DEFAULT 0 NOT NULL,
	"checks" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"migration_run_id" uuid,
	"source_environment_id" uuid NOT NULL,
	"target_environment_id" uuid NOT NULL,
	"tables" jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"outcome" text,
	"summary" jsonb,
	"progress_message" text,
	"error_message" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_runs" ADD CONSTRAINT "comparison_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_runs" ADD CONSTRAINT "comparison_runs_source_environment_id_environments_id_fk" FOREIGN KEY ("source_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_runs" ADD CONSTRAINT "comparison_runs_target_environment_id_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_runs" ADD CONSTRAINT "comparison_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_table_results" ADD CONSTRAINT "comparison_table_results_comparison_run_id_comparison_runs_id_fk" FOREIGN KEY ("comparison_run_id") REFERENCES "public"."comparison_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_access" ADD CONSTRAINT "environment_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_access" ADD CONSTRAINT "environment_access_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_mappings" ADD CONSTRAINT "field_mappings_plan_entity_id_migration_plan_entities_id_fk" FOREIGN KEY ("plan_entity_id") REFERENCES "public"."migration_plan_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_mappings" ADD CONSTRAINT "field_mappings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metadata_catalogs" ADD CONSTRAINT "metadata_catalogs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metadata_tables" ADD CONSTRAINT "metadata_tables_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_errors" ADD CONSTRAINT "migration_errors_run_id_migration_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."migration_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_plan_entities" ADD CONSTRAINT "migration_plan_entities_plan_id_migration_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."migration_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_plans" ADD CONSTRAINT "migration_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_plans" ADD CONSTRAINT "migration_plans_source_environment_id_environments_id_fk" FOREIGN KEY ("source_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_plans" ADD CONSTRAINT "migration_plans_target_environment_id_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_plans" ADD CONSTRAINT "migration_plans_comparison_run_id_comparison_runs_id_fk" FOREIGN KEY ("comparison_run_id") REFERENCES "public"."comparison_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_plans" ADD CONSTRAINT "migration_plans_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_record_maps" ADD CONSTRAINT "migration_record_maps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_record_maps" ADD CONSTRAINT "migration_record_maps_run_id_migration_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."migration_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_run_entities" ADD CONSTRAINT "migration_run_entities_run_id_migration_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."migration_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_plan_id_migration_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."migration_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_source_environment_id_environments_id_fk" FOREIGN KEY ("source_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_target_environment_id_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_executed_by_user_id_users_id_fk" FOREIGN KEY ("executed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_categories" ADD CONSTRAINT "table_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_caches" ADD CONSTRAINT "token_caches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_source_environment_id_environments_id_fk" FOREIGN KEY ("source_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_target_environment_id_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_differences" ADD CONSTRAINT "validation_differences_validation_run_id_validation_runs_id_fk" FOREIGN KEY ("validation_run_id") REFERENCES "public"."validation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_entity_results" ADD CONSTRAINT "validation_entity_results_validation_run_id_validation_runs_id_fk" FOREIGN KEY ("validation_run_id") REFERENCES "public"."validation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_migration_run_id_migration_runs_id_fk" FOREIGN KEY ("migration_run_id") REFERENCES "public"."migration_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_source_environment_id_environments_id_fk" FOREIGN KEY ("source_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_target_environment_id_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "comparison_runs_org_created_idx" ON "comparison_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "comparison_table_results_uq" ON "comparison_table_results" USING btree ("comparison_run_id","logical_name");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_org_url_uq" ON "environments" USING btree ("organization_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "field_mappings_uq" ON "field_mappings" USING btree ("plan_entity_id","source_field");--> statement-breakpoint
CREATE INDEX "jobs_status_run_after_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "jobs_target_idx" ON "jobs" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "migration_errors_run_idx" ON "migration_errors" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "migration_errors_record_idx" ON "migration_errors" USING btree ("run_id","logical_name","source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_plan_entities_uq" ON "migration_plan_entities" USING btree ("plan_id","logical_name");--> statement-breakpoint
CREATE INDEX "migration_plans_org_created_idx" ON "migration_plans" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_record_maps_run_uq" ON "migration_record_maps" USING btree ("run_id","logical_name","source_id");--> statement-breakpoint
CREATE INDEX "migration_record_maps_pair_idx" ON "migration_record_maps" USING btree ("organization_id","source_environment_id","target_environment_id","logical_name","source_id");--> statement-breakpoint
CREATE INDEX "migration_record_maps_deferred_idx" ON "migration_record_maps" USING btree ("run_id","deferred_status");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_run_entities_uq" ON "migration_run_entities" USING btree ("run_id","logical_name");--> statement-breakpoint
CREATE INDEX "migration_runs_org_created_idx" ON "migration_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "migration_runs_plan_idx" ON "migration_runs" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_external_uq" ON "users" USING btree ("organization_id","external_id");--> statement-breakpoint
CREATE INDEX "validation_differences_run_idx" ON "validation_differences" USING btree ("validation_run_id","logical_name");--> statement-breakpoint
CREATE UNIQUE INDEX "validation_entity_results_uq" ON "validation_entity_results" USING btree ("validation_run_id","logical_name");--> statement-breakpoint
CREATE INDEX "validation_runs_org_created_idx" ON "validation_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "validation_runs_migration_idx" ON "validation_runs" USING btree ("migration_run_id");