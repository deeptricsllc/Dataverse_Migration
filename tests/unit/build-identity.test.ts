import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCT_VERSION } from '../../shared/product';
import { buildIdentity, describeBuild, publicBuildIdentity } from '../../server/src/build-info';

/**
 * Which build produced this.
 *
 * The question that gets asked when a report is disputed, and the one nobody can answer from memory.
 * These cases are about two things: that the version cannot drift from `package.json`, and that the
 * public half of the identity says nothing a hostname does not already reveal.
 */

const config = (overrides: Partial<{ APP_BASE_URL: string; NODE_ENV: string }> = {}) => ({
  APP_BASE_URL: 'https://migrate.example.com',
  NODE_ENV: 'production',
  ...overrides,
});

describe('the version cannot drift', () => {
  it('matches package.json exactly', () => {
    /**
     * `PRODUCT_VERSION` is duplicated from package.json on purpose: reading the file at runtime needs
     * either a build step that injects it or a filesystem read from inside a bundle, and both fail
     * quietly in a way a constant cannot. This is the thing that makes the duplication safe, so if it
     * ever fails, update the constant rather than this test.
     */
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(PRODUCT_VERSION).toBe(pkg.version);
  });
});

describe('the commit, from whichever variable the builder sets', () => {
  it('reads each platform’s variable and shortens the hash', () => {
    const full = '0123456789abcdef0123456789abcdef01234567';
    for (const key of [
      'BUILD_COMMIT',
      'RAILWAY_GIT_COMMIT_SHA',
      'GIT_COMMIT',
      'COMMIT_SHA',
      'SOURCE_VERSION',
    ]) {
      const identity = buildIdentity(config(), { [key]: full } as NodeJS.ProcessEnv);
      expect(identity.commit, key).toBe('0123456789ab');
    }
  });

  it('says nothing rather than something wrong', () => {
    expect(buildIdentity(config(), {} as NodeJS.ProcessEnv).commit).toBeNull();
    // Not a hash: a branch name, a tag, an injected template that never got substituted.
    for (const value of ['main', '', '$COMMIT_SHA', 'not-a-hash', 'zzzzzzz']) {
      expect(buildIdentity(config(), { BUILD_COMMIT: value } as NodeJS.ProcessEnv).commit, value).toBeNull();
    }
  });

  it('refuses a branch name that is not one, so nothing unexpected reaches a page', () => {
    expect(buildIdentity(config(), { BUILD_BRANCH: 'phase-4/pilot' } as never).branch).toBe('phase-4/pilot');
    for (const value of ['has spaces', 'https://evil.example/x', '<script>', 'a'.repeat(200)]) {
      expect(buildIdentity(config(), { BUILD_BRANCH: value } as never).branch, value).toBeNull();
    }
  });
});

describe('which deployment this is', () => {
  it('derives it from the hostname, so it cannot disagree with reality', () => {
    /**
     * A deployment that says "production" in a variable while serving a QA hostname is worse than one
     * that says nothing, so this is derived rather than configured.
     */
    const cases: [string, string][] = [
      ['https://dataverse-migration-app-qa.up.railway.app', 'qa'],
      ['https://migrate-staging.example.com', 'staging'],
      ['https://migrate.example.com', 'migrate'],
      ['http://localhost:3000', 'local'],
      ['http://127.0.0.1:3000', 'local'],
    ];
    for (const [url, expected] of cases) {
      expect(buildIdentity(config({ APP_BASE_URL: url }), {} as never).deployment, url).toBe(expected);
    }
  });

  it('falls back to the environment when the base url is unusable', () => {
    expect(buildIdentity(config({ APP_BASE_URL: 'not a url' }), {} as never).deployment).toBe('production');
  });
});

describe('what the public half reveals', () => {
  it('gives the version and the deployment, and not the commit', () => {
    const identity = buildIdentity(config(), {
      BUILD_COMMIT: '0123456789abcdef0123456789abcdef01234567',
      BUILD_BRANCH: 'main',
    } as never);
    const shown = publicBuildIdentity(identity);

    expect(shown).toEqual({ version: PRODUCT_VERSION, deployment: 'migrate' });
    // A commit identifier for a private repository is not a secret, and it is not useful to a stranger
    // either, so it sits behind the session rather than in front of it.
    expect(Object.keys(shown)).not.toContain('commit');
    expect(JSON.stringify(shown)).not.toContain('0123456789ab');
    expect(JSON.stringify(shown)).not.toContain('main');
    // And nothing about the machine.
    expect(Object.keys(shown)).not.toContain('nodeEnv');
    expect(Object.keys(shown)).not.toContain('startedAt');
  });

  it('describes a build in one line, for a log or a report', () => {
    const withCommit = describeBuild(
      buildIdentity(config(), {
        BUILD_COMMIT: '0123456789abcdef0123456789abcdef01234567',
        BUILD_BRANCH: 'main',
      } as never),
    );
    expect(withCommit).toBe(`v${PRODUCT_VERSION} · migrate · main@0123456789ab`);

    const withoutCommit = describeBuild(buildIdentity(config(), {} as never));
    expect(withoutCommit).toBe(`v${PRODUCT_VERSION} · migrate`);
  });
});
