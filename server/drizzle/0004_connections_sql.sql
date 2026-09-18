CREATE TABLE "connection_secrets" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "connection_type" text DEFAULT 'DATAVERSE' NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "sql_config" jsonb;--> statement-breakpoint
ALTER TABLE "field_mappings" ADD COLUMN "compatibility" text DEFAULT 'COMPATIBLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "field_mappings" ADD COLUMN "transform" jsonb DEFAULT '{"kind":"DIRECT"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "field_mappings" ADD COLUMN "choice_map" jsonb;--> statement-breakpoint
ALTER TABLE "migration_plan_entities" ADD COLUMN "target_logical_name" text;--> statement-breakpoint
ALTER TABLE "migration_plan_entities" ADD COLUMN "target_display_name" text;--> statement-breakpoint
ALTER TABLE "migration_plan_entities" ADD COLUMN "object_mapping_status" text DEFAULT 'EXACT' NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_secrets" ADD CONSTRAINT "connection_secrets_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_secrets" ADD CONSTRAINT "connection_secrets_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;