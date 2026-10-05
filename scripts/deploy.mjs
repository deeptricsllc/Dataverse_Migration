#!/usr/bin/env node
/**
 * Deploy the working tree, with provenance taken from git rather than typed by hand.
 *
 * The deployment platform for this project has no git source: `railway up` uploads whatever is in the
 * working directory, so nothing on the platform knows which branch or commit an image came from. The
 * only record is `BUILD_COMMIT` / `BUILD_BRANCH`, which `server/src/build-info.ts` reads and
 * `/api/settings` reports.
 *
 * Those were maintained by hand, and a hand-maintained fact drifts. A QA deployment went on reporting
 * the branch of a previous release for several commits, which is worse than reporting nothing: the one
 * question provenance exists to answer — "which build produced this?" — was answered confidently and
 * wrongly. So this reads the two values from the repository being uploaded, immediately before
 * uploading it, and refuses to deploy anything whose provenance it cannot state truthfully:
 *
 *   - a dirty working tree, because the commit would not describe what was sent;
 *   - a detached HEAD, because there is no branch to name;
 *   - a commit absent from the remote, because a SHA nobody else can resolve identifies nothing.
 *
 * Deliberately not a release gate. `scripts/release-gate.mjs` decides whether a build is fit to deploy;
 * this one only makes sure the deployment says what it is.
 *
 *   RAILWAY_API_TOKEN=… RAILWAY_PROJECT_ID=… RAILWAY_ENVIRONMENT_ID=… RAILWAY_SERVICE_ID=… \
 *     node scripts/deploy.mjs
 *
 * The token is read from the environment and never printed, logged, or written anywhere.
 */
import { spawnSync } from 'node:child_process';

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';

/** Trimmed stdout of a git command, or null when it failed. Never throws on a non-zero exit. */
function git(...args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

function refuse(what, why) {
  console.error(`Refusing to deploy: ${what}\n  ${why}`);
  process.exit(1);
}

const token = process.env.RAILWAY_API_TOKEN ?? process.env.RAILWAY_TOKEN;
const project = process.env.RAILWAY_PROJECT_ID;
const environment = process.env.RAILWAY_ENVIRONMENT_ID;
const service = process.env.RAILWAY_SERVICE_ID;
for (const [name, value] of [
  ['RAILWAY_API_TOKEN (or RAILWAY_TOKEN)', token],
  ['RAILWAY_PROJECT_ID', project],
  ['RAILWAY_ENVIRONMENT_ID', environment],
  ['RAILWAY_SERVICE_ID', service],
]) {
  if (!value) refuse(`${name} is not set`, 'The target of a deployment is never guessed.');
}

// --- what is about to be uploaded, and whether it can be described honestly --------------------
const dirty = git('status', '--porcelain');
if (dirty === null) refuse('this is not a git repository', 'Provenance has nothing to read.');
if (dirty !== '') {
  refuse(
    'the working tree has uncommitted changes',
    'The image would contain them while the recorded commit would not mention them. Commit or stash first.',
  );
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (!branch || branch === 'HEAD') {
  refuse('HEAD is detached', 'There is no branch name to record. Check out a branch first.');
}

const commit = git('rev-parse', 'HEAD');
if (!commit) refuse('HEAD does not resolve to a commit', 'An empty repository has nothing to deploy.');

const onRemote = (git('branch', '-r', '--contains', commit) ?? '')
  .split('\n')
  .map((line) => line.replace('*', '').trim())
  .filter(Boolean);
if (!onRemote.length) {
  refuse(
    `commit ${commit.slice(0, 12)} is not on any remote branch`,
    'Nobody reading the provenance could resolve it. Push the branch first.',
  );
}

console.log(`Deploying ${branch}@${commit.slice(0, 12)}`);
console.log(`  on the remote as: ${onRemote.join(', ')}`);

// --- record it on the service before the build, so the running image reads the truth -----------
async function upsert(name, value) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Project-Access-Token': token },
    body: JSON.stringify({
      query: `mutation Upsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
      variables: {
        input: { projectId: project, environmentId: environment, serviceId: service, name, value },
      },
    }),
  });
  const body = await res.json();
  if (body.errors) {
    // The message may name the variable but never its value, and the token is not in scope here.
    refuse(`${name} could not be recorded`, body.errors.map((e) => e.message).join('; '));
  }
  console.log(`  ${name} = ${value}`);
}

await upsert('BUILD_BRANCH', branch);
await upsert('BUILD_COMMIT', commit);

// --- upload ------------------------------------------------------------------------------------
const up = spawnSync(
  process.platform === 'win32' ? 'railway.cmd' : 'railway',
  ['up', '--detach', '--project', project, '--environment', environment, '--service', service],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
if (up.status !== 0) {
  console.error(`\nrailway up exited ${up.status}. The provenance variables are already set to the`);
  console.error('commit above; a later successful deploy of the same commit will match them.');
  process.exit(up.status ?? 1);
}

console.log(`\nUploaded. QA will report ${branch}@${commit.slice(0, 12)} once the deployment is live.`);
console.log('Verify it, rather than assuming it: GET /api/settings and read build.branch and build.commit.');
