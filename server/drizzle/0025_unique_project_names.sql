-- Active project names are unique per workspace.
--
-- Three projects called "Test_Analysis" could be created, which makes a project name useless as a way to
-- refer to anything: navigation, exports, audit entries, run history and a support conversation all end up
-- ambiguous. Uniqueness is enforced here rather than only in the service, because two concurrent requests
-- both pass a "does this name exist" check before either has inserted.
--
-- Scoped to ACTIVE on purpose. Archiving a project should not reserve its name forever, and a team that
-- archives "Q3 Migration" and starts a new one next quarter is doing a normal thing.
--
-- Case-insensitive, because "Customer Migration" and "customer migration" are the same name to a person,
-- and the ambiguity this prevents is a human one.

-- ---------------------------------------------------------------------------
-- First, the duplicates that already exist.
--
-- This is the step the first version of this migration did not have, and it took QA down: the index was
-- created against a database that already contained two projects called "Test_Analysis" — which is the
-- exact bug being fixed here — so `CREATE UNIQUE INDEX` failed, the migration aborted, and the application
-- crash-looped on startup. A constraint that cannot be satisfied by the data it is being added to has to
-- bring that data into line first, or it is not a migration, it is an outage.
--
-- Nothing is deleted and nothing is archived. The oldest project of each clashing name keeps the name it
-- has; every later one is renamed by appending the first block of its own id. That suffix is chosen
-- because it is unique by construction, so two renamed projects cannot collide with each other, and
-- because it is visible — somebody opening the workspace can see which project was disambiguated and go
-- and give it a better name. A silent rename is still a rename, so it should look like one.
UPDATE "projects" AS p
SET "name" = p."name" || ' (' || left(p."id"::text, 8) || ')'
FROM (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "organization_id", lower("name")
			ORDER BY "created_at", "id"
		) AS rn
	FROM "projects"
	WHERE "status" = 'ACTIVE'
) AS ranked
WHERE p."id" = ranked."id" AND ranked.rn > 1;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "projects_org_active_name_unique"
	ON "projects" (organization_id, lower(name))
	WHERE status = 'ACTIVE';
