#!/usr/bin/env node
/**
 * Compares what the engines just proved against what the repository claims they prove.
 *
 * The committed evidence file is what the capability matrix is checked against, so it has to keep
 * describing reality. A raw `git diff` cannot do this job: every run writes a fresh timestamp and
 * the container's patch version moves on its own, so the file always differs and a check built on
 * that would cry wolf until somebody stopped reading it.
 *
 * What matters is the claim, so that is what is compared:
 *
 *   - an engine that was being claimed and no longer passes        → failure
 *   - a capability that was being claimed and no longer passes     → failure
 *   - a capability that now passes and is not yet committed        → failure, commit it
 *   - a newer server version, or a new timestamp                   → noted, not a failure
 *
 * Usage: node scripts/check-evidence-drift.mjs <committed.json> <fresh.json>
 */

import fs from 'node:fs';

const [, , committedPath, freshPath] = process.argv;
if (!committedPath || !freshPath) {
  console.error('usage: check-evidence-drift.mjs <committed.json> <fresh.json>');
  process.exit(2);
}

const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { runs: {} });
const committed = read(committedPath);
const fresh = read(freshPath);

const problems = [];
const notes = [];

for (const [engine, before] of Object.entries(committed.runs ?? {})) {
  const after = fresh.runs?.[engine];
  if (!after) {
    problems.push(`${engine}: committed evidence claims a passing run, but this run produced none.`);
    continue;
  }
  const had = Object.keys(before.capabilities ?? {});
  const has = new Set(Object.keys(after.capabilities ?? {}));
  for (const capability of had) {
    if (!has.has(capability)) {
      problems.push(`${engine}.${capability}: was proved before and did not pass this time.`);
    }
  }
  if (before.serverVersion !== after.serverVersion) {
    notes.push(`${engine}: server version moved from "${before.serverVersion}" to "${after.serverVersion}".`);
  }
}

for (const [engine, after] of Object.entries(fresh.runs ?? {})) {
  const before = committed.runs?.[engine];
  const newly = Object.keys(after.capabilities ?? {}).filter((c) => !(before?.capabilities ?? {})[c]);
  if (newly.length > 0) {
    problems.push(
      `${engine}: ${newly.join(', ')} now pass but are not in the committed evidence. ` +
        'Commit evidence/engine-verification.json so the matrix can rely on them.',
    );
  }
}

for (const note of notes) console.warn(`note: ${note}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}
console.warn('Engine evidence matches what the repository claims.');
