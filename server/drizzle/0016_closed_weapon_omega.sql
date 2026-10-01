ALTER TABLE "validation_entity_results" ADD COLUMN "coverage" jsonb;--> statement-breakpoint
ALTER TABLE "validation_entity_results" ADD COLUMN "duplicates" jsonb;--> statement-breakpoint
ALTER TABLE "validation_entity_results" ADD COLUMN "duplicate_coverage" jsonb;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD COLUMN "depth" text;