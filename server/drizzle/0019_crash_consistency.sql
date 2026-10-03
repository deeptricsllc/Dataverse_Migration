ALTER TABLE "migration_record_maps" ADD COLUMN "write_state" text;--> statement-breakpoint
ALTER TABLE "migration_record_maps" ADD COLUMN "intended_operation" text;--> statement-breakpoint
ALTER TABLE "migration_record_maps" ADD COLUMN "reconcile_evidence" text;--> statement-breakpoint
ALTER TABLE "migration_record_maps" ADD COLUMN "reconcile_note" text;--> statement-breakpoint
ALTER TABLE "migration_run_entities" ADD COLUMN "unresolved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD COLUMN "unresolved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "migration_record_maps_write_state_idx" ON "migration_record_maps" USING btree ("run_id","write_state");