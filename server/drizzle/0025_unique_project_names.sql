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
CREATE UNIQUE INDEX IF NOT EXISTS "projects_org_active_name_unique"
  ON "projects" (organization_id, lower(name))
  WHERE status = 'ACTIVE';
