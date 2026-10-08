ALTER TABLE "validation_entity_results" ADD COLUMN IF NOT EXISTS "comparison_rules" jsonb;
--> statement-breakpoint
ALTER TABLE "validation_entity_results" ADD COLUMN IF NOT EXISTS "finding_counts" jsonb;
