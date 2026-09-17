ALTER TABLE "comparison_table_results" ADD COLUMN "source_count" integer;--> statement-breakpoint
ALTER TABLE "comparison_table_results" ADD COLUMN "target_count" integer;--> statement-breakpoint
ALTER TABLE "comparison_table_results" ADD COLUMN "count_approximate" boolean DEFAULT false NOT NULL;