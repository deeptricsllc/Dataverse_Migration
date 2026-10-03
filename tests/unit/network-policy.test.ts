import { describe, expect, it } from 'vitest';
import { checkOutboundHost } from '../../server/src/lib/network-policy';

/**
 * Where this deployment will dial.
 *
 * A migration platform connects to a host a signed-in user typed in, which is the product working and
 * also a server-side request forgery primitive if nothing bounds it. The bound is narrow on purpose:
 * private ranges stay open, because a customer's database on 10.x behind a tunnel is the normal shape
 * of an enterprise migration, and refusing it would break the product to prevent nothing.
 */
describe('hosts this deployment refuses', () => {
  const refused = (host: string) => checkOutboundHost(host);

  it('refuses loopback, by name and by address, in both families', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'localhost.localdomain',
      '127.0.0.1',
      '127.1.2.3',
      '127.0.0.1:5432',
      '::1',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      'ip6-localhost',
    ]) {
      const verdict = refused(host);
      expect(verdict.allowed, host).toBe(false);
      expect(verdict.reason, host).toMatch(/loopback/);
    }
  });

  it('refuses the link-local range, which is where instance metadata lives', () => {
    // 169.254.169.254 hands out instance credentials on several providers to anything that asks.
    for (const host of ['169.254.169.254', '169.254.0.1', 'fe80::1', 'FE80::abcd', 'fe9a::1']) {
      const verdict = refused(host);
      expect(verdict.allowed, host).toBe(false);
      expect(verdict.reason, host).toMatch(/link-local|hosting environment/);
    }
  });

  it('refuses the metadata hostnames the providers publish', () => {
    for (const host of ['metadata.google.internal', 'instance-data', 'metadata.goog']) {
      expect(refused(host).allowed, host).toBe(false);
    }
  });

  it('refuses the unspecified address, which resolves to this host', () => {
    for (const host of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0']) {
      expect(refused(host).allowed, host).toBe(false);
    }
  });

  it('refuses an IPv4 loopback smuggled inside IPv6, which is the usual way past a name check', () => {
    expect(refused('::ffff:127.0.0.1').allowed).toBe(false);
    expect(refused('[::ffff:127.0.0.1]').allowed).toBe(false);
    expect(refused('::ffff:169.254.169.254').allowed).toBe(false);
  });

  it('sees through the forms a host can arrive in', () => {
    for (const host of [
      '  localhost  ',
      'localhost.',
      'http://localhost',
      'localhost/db',
      '[fe80::1%eth0]',
      'postgres://127.0.0.1/db',
    ]) {
      expect(refused(host).allowed, host).toBe(false);
    }
  });

  it('strips a trailing port without truncating an IPv6 address', () => {
    // A person types the port even though it has its own field.
    expect(refused('127.0.0.1:5432').allowed).toBe(false);
    expect(refused('localhost:1433').allowed).toBe(false);
    expect(refused('169.254.169.254:80').allowed).toBe(false);
    // And an IPv6 address must not lose its last group to the same rule.
    expect(checkOutboundHost('2001:db8::1').allowed, 'a public IPv6 address survives').toBe(true);
    expect(checkOutboundHost('fd00::1').allowed).toBe(true);
    expect(refused('fe80::1').allowed, 'and a link-local one is still refused').toBe(false);
  });

  it('refuses an empty host with something a person can act on', () => {
    expect(refused('').allowed).toBe(false);
    expect(refused('   ').reason).toMatch(/required/);
  });
});

describe('hosts this deployment allows', () => {
  it('allows private ranges, because that is where customer databases are', () => {
    /**
     * The tempting rule — refuse anything private — would break the main case. A SQL Server on a
     * customer's internal network reached through a tunnel is what this product is for.
     */
    for (const host of [
      '10.0.0.5',
      '10.255.255.254',
      '172.16.4.9',
      '172.31.0.1',
      '192.168.1.50',
      'sql01.internal.contoso.com',
      'db.corp.local',
      'fd00::1',
    ]) {
      expect(checkOutboundHost(host).allowed, host).toBe(true);
    }
  });

  it('allows ordinary public hosts', () => {
    for (const host of [
      'contoso.database.windows.net',
      'my-db.abc123.eu-west-1.rds.amazonaws.com',
      '203.0.113.10',
      '2001:db8::1',
    ]) {
      expect(checkOutboundHost(host).allowed, host).toBe(true);
    }
  });

  it('rejects an address that is not an address at all', () => {
    expect(checkOutboundHost('999.1.1.1').allowed).toBe(false);
  });

  it('opens loopback only when the deployment says so out loud', () => {
    // For a developer against a database on their own machine, and for CI against containers.
    expect(checkOutboundHost('localhost', { allowInternal: true }).allowed).toBe(true);
    expect(checkOutboundHost('127.0.0.1', { allowInternal: true }).allowed).toBe(true);
    expect(checkOutboundHost('169.254.169.254', { allowInternal: true }).allowed).toBe(true);
    // And the default is closed, which is the point of having the flag at all.
    expect(checkOutboundHost('localhost', {}).allowed).toBe(false);
    expect(checkOutboundHost('localhost', { allowInternal: false }).allowed).toBe(false);
  });
});

describe('what this does not do, stated so it is not mistaken for complete', () => {
  it('does not resolve names, so a name pointing at loopback is still allowed through', () => {
    /**
     * A hostname under an attacker's control can resolve to 127.0.0.1 and this will allow it. Closing
     * that means resolving the name and pinning the connection to the address that was checked, which
     * none of the three drivers will do without supplying our own socket — a real piece of work rather
     * than a line of validation.
     *
     * Asserted rather than left implicit, so the limit is visible to whoever reads this next and cannot
     * be mistaken for a bug in the rules above.
     */
    expect(checkOutboundHost('loopback.example.com').allowed).toBe(true);
  });
});
