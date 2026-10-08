-- How far a demo workspace got in building its worked examples.
--
-- Additive and nullable. A demo workspace built before this column existed has no status and is
-- read as ready when its projects are present, which they are -- backfilling a status onto it would
-- be stating something nobody recorded. Every other organization is not a demo and never gets one.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "demo_setup_status" text;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "demo_setup_detail" text;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "demo_setup_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "demo_setup_updated_at" timestamp with time zone;
