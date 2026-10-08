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

/**
 * Two ways to reach the platform, and the guardrails above apply to both.
 *
 * With a project token, the variables go over the API and the target is named outright. Without one,
 * the Railway CLI is already signed in and already linked to a project and environment, and asking
 * for a token that the CLI is holding anyway would mean a credential travelling somewhere it does
 * not need to travel. So the CLI path is supported, and it names the target from the link rather
 * than from an argument nobody checked.
 *
 * What it must never become is a path that skips the provenance. Both paths set BUILD_BRANCH and
 * BUILD_COMMIT from git before the upload, and both refuse a tree the commit does not describe.
 */
const viaApi = Boolean(token);
if (viaApi) {
  for (const [name, value] of [
    ['RAILWAY_PROJECT_ID', project],
    ['RAILWAY_ENVIRONMENT_ID', environment],
    ['RAILWAY_SERVICE_ID', service],
  ]) {
    if (!value) refuse(`${name} is not set`, 'The target of a deployment is never guessed.');
  }
}

const RAILWAY = process.platform === 'win32' ? 'railway.cmd' : 'railway';
/**
 * Which service and environment the CLI path acts on, when the caller named them.
 *
 * A linked project can hold several services, and `railway up` with none named is a question the CLI
 * asks a person. Naming them is how an unattended deploy stays unambiguous; leaving them out falls
 * back to the link, which is what an interactive caller expects.
 */
const cliTarget = [
  ...(service ? ['--service', service] : []),
  ...(environment ? ['--environment', environment] : []),
];
/** Runs the Railway CLI, inheriting the signed-in session. Returns the exit status. */
function railway(args, { capture = false } = {}) {
  return spawnSync(RAILWAY, args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}

if (!viaApi) {
  const status = railway(['status', '--json'], { capture: true });
  if (status.status !== 0) {
    /*
     * The CLI's own words, not a guess at them. The first time this refused, the reason was that the
     * CLI reads RAILWAY_ENVIRONMENT_ID and RAILWAY_SERVICE_ID itself and rejects either without
     * RAILWAY_PROJECT_ID — which the message below says outright and the sentence above never would.
     */
    refuse(
      'no RAILWAY_API_TOKEN is set and the Railway CLI is not usable',
      `${(status.stderr || status.stdout || 'the CLI gave no reason').trim()}
  Either export a project token, or sign in and link a project with \`railway link\`.`,
    );
  }
  let linked;
  try {
    linked = JSON.parse(status.stdout);
  } catch {
    refuse('the Railway CLI did not report a linked project', 'Nothing names the target.');
  }
  // Printed, not guessed at: a deployment that does not say where it is going is the bug this file
  // exists to prevent, whichever path it took to get there.
  console.log(`Target: ${linked.name ?? 'unknown project'} (from the Railway CLI link)`);
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
  if (!viaApi) {
    /*
     * `--skip-deploys`, because the upload below is the deployment. Without it each variable
     * triggers its own redeploy of the *previous* image, so the service would build the old commit
     * twice while announcing the new one.
     */
    const res = railway(['variables', '--set', `${name}=${value}`, '--skip-deploys', ...cliTarget], {
      capture: true,
    });
    if (res.status !== 0) {
      refuse(`${name} could not be recorded`, (res.stderr || res.stdout || '').trim());
    }
    console.log(`  ${name} = ${value}`);
    return;
  }
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
const up = railway(
  viaApi
    ? ['up', '--detach', '--project', project, '--environment', environment, '--service', service]
    : ['up', '--detach', ...cliTarget],
);
if (up.status !== 0) {
  console.error(`\nrailway up exited ${up.status}. The provenance variables are already set to the`);
  console.error('commit above; a later successful deploy of the same commit will match them.');
  process.exit(up.status ?? 1);
}

console.log(`\nUploaded. QA will report ${branch}@${commit.slice(0, 12)} once the deployment is live.`);
console.log('Verify it, rather than assuming it: GET /api/settings and read build.branch and build.commit.');
