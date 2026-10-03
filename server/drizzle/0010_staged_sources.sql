CREATE TABLE "staged_rows" (
	"environment_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"record_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "staged_rows_environment_id_logical_name_record_id_pk" PRIMARY KEY("environment_id","logical_name","record_id")
);
--> statement-breakpoint
CREATE TABLE "staged_tables" (
	"environment_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"sheet_name" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"key_column" text NOT NULL,
	"key_is_synthetic" boolean DEFAULT true NOT NULL,
	"metadata" jsonb NOT NULL,
	"columns" jsonb NOT NULL,
	"imported_by_user_id" uuid,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staged_tables_environment_id_logical_name_pk" PRIMARY KEY("environment_id","logical_name")
);
--> statement-breakpoint
ALTER TABLE "staged_rows" ADD CONSTRAINT "staged_rows_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_tables" ADD CONSTRAINT "staged_tables_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_tables" ADD CONSTRAINT "staged_tables_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staged_rows_order_idx" ON "staged_rows" USING btree ("environment_id","logical_name","ordinal");