-- What a person decided about something the engine observed.
--
-- Kept in its own table, and that separation is the whole point. A finding is evidence: it says what was
-- measured and when. A disposition is a judgement: somebody looked at the evidence and decided it is an
-- accepted risk, or obsolete, or going to be fixed. Writing the judgement back onto the finding would
-- destroy the record of what was actually observed, and the next analysis would quietly disagree with
-- a history nobody can reconstruct.
--
-- So findings stay derived from the stored profiles and are never edited. This table is the only thing a
-- user writes, and it is addressed by the finding's deterministic id.
CREATE TABLE IF NOT EXISTS "finding_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	-- The finding's stable id: dataset|table|column|rule. Deliberately not a foreign key, because
	-- findings are computed rather than stored, and a decision has to survive the next analysis run.
	"finding_id" text NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- One current decision per finding per project. The history of decisions is the audit trail's job.
CREATE UNIQUE INDEX IF NOT EXISTS "finding_dispositions_project_finding_uq" ON "finding_dispositions" USING btree ("project_id","finding_id");
