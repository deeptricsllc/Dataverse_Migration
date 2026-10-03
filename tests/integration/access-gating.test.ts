import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/src/config';

/**
 * Who is allowed in, and whether that was decided or merely happened.
 *
 * The rule used to be "refuse if an allow-list exists and excludes you". With no list that means
 * "admit everybody", so a deployment could become an open beta because nobody set a variable —
 * which is the one way that decision should never be made. These assertions exist so that opening
 * a deployment up takes an explicit setting that somebody has to write down and can be asked about.
 */
describe('access mode', () => {
  const base = {
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    DATABASE_URL: '',
    PGLITE_DATA_DIR: 'memory://',
    SESSION_SECRET: 'test-only-session-secret-0123456789abcdef',
  } as Record<string, string>;

  it('is gated unless somebody says otherwise', () => {
    const config = loadConfig({ ...base });
    expect(config.ACCESS_MODE, 'an unset deployment is closed, not open').toBe('GATED');
  });

  it('does not treat an empty allow list as permission for everybody', () => {
    const config = loadConfig({ ...base, ENTRA_CLIENT_ID: 'x', ENTRA_CLIENT_SECRET: 'y' });
    expect(config.allowedTenantIds).toEqual([]);
    expect(config.ACCESS_MODE).toBe('GATED');
    // With Microsoft sign-in on, no allow list and GATED, nobody new gets in — which is the
    // behaviour an operator who configured nothing should get.
  });

  it('opens up only when asked to, in words', () => {
    const open = loadConfig({
      ...base,
      ENTRA_CLIENT_ID: 'x',
      ENTRA_CLIENT_SECRET: 'y',
      ACCESS_MODE: 'OPEN_BETA',
    });
    expect(open.ACCESS_MODE).toBe('OPEN_BETA');
  });

  it('reads an allow list without caring how it was spaced or cased', () => {
    const config = loadConfig({
      ...base,
      ALLOWED_TENANT_IDS: ' AAAA-BBBB , cccc-dddd,, ',
    });
    expect(config.allowedTenantIds).toEqual(['aaaa-bbbb', 'cccc-dddd']);
  });
});
