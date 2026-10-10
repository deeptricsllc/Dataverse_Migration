/**
 * Where this deployment is willing to open an outbound connection.
 *
 * A migration platform exists to connect to somebody else's database, so the host is supplied by a
 * signed-in user and the server dials it. That is the product working as intended, and it is also a
 * server-side request forgery primitive if nothing bounds it: a tenant could point a connection at the
 * hosting platform's own loopback services, or at the cloud metadata endpoint on 169.254.169.254,
 * which on several providers hands out instance credentials to anything that asks.
 *
 * The bound has to be chosen carefully, because the obvious rule is wrong. "Refuse private addresses"
 * would break the main case: a customer's SQL Server on 10.x reached through a tunnel is the normal
 * shape of an enterprise migration, not an attack. So private ranges are allowed and the refusals are
 * narrow and specific:
 *
 *   - **loopback** — the deployment's own services, which no customer database is ever on;
 *   - **link-local** — 169.254/16 and fe80::/10, which is where cloud instance metadata lives;
 *   - **the unspecified address** — 0.0.0.0 and ::, which resolve to "this host" in most stacks;
 *   - **the metadata hostnames** the providers publish, because a name resolves to the same place.
 *
 * Everything else is allowed. This is a bound on obviously-internal destinations, not an allow-list,
 * and `docs/SECURITY.md` says so rather than implying the product has been made unable to reach
 * anything it should not.
 *
 * One deliberate limit, stated because it would otherwise look like an oversight: **this checks the
 * host as written, not the address it resolves to.** A hostname under the user's control can point at
 * 127.0.0.1, and nothing here stops that. Closing it properly means resolving the name and pinning the
 * connection to the address that was checked, which neither `pg`, `mysql2` nor `mssql` will do without
 * supplying our own socket. That is a real piece of work rather than a line of validation, so what is
 * here refuses the direct forms and the gap is recorded instead of being papered over.
 */

export interface HostPolicyVerdict {
  allowed: boolean;
  /** Why not, in words a customer can act on. Never names the deployment's own addresses. */
  reason?: string;
}

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

/**
 * Hostnames the major providers publish for instance metadata. Named rather than resolved, because
 * refusing the name is worth doing even though it is not sufficient on its own.
 */
const METADATA_NAMES = [
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Verdict(octets: number[]): HostPolicyVerdict | null {
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) {
    return { allowed: false, reason: 'a loopback address reaches this platform rather than your database' };
  }
  if (a === 0) {
    return { allowed: false, reason: 'that address does not name a reachable server' };
  }
  if (a === 169 && b === 254) {
    return {
      allowed: false,
      reason: 'link-local addresses (169.254.x.x) belong to the hosting environment, not to a database',
    };
  }
  return null;
}

/** Strips the forms a host can arrive in: brackets, a zone id, a trailing dot, a scheme. */
function normalize(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.includes('://')) value = value.slice(value.indexOf('://') + 3);
  value = value.replace(/\/.*$/, '');
  if (value.startsWith('['))
    value = value.slice(1, value.indexOf(']') === -1 ? undefined : value.indexOf(']'));
  value = value.replace(/%.*$/, '');
  /**
   * A trailing port, which a person types even though the port has its own field. Only when what is
   * left holds no other colon, so an IPv6 address is not truncated at its last group.
   */
  const withoutPort = value.replace(/:\d+$/, '');
  if (!withoutPort.includes(':')) value = withoutPort;
  value = value.replace(/\.$/, '');
  return value;
}

/**
 * Whether this deployment will dial that host.
 *
 * `allowInternal` exists for the two cases that legitimately need loopback: a developer running the
 * product against a database on their own machine, and the conformance suites against containers in
 * continuous integration. It defaults to off, so a deployment is closed unless somebody writes down
 * that it should be open.
 */
export function checkOutboundHost(
  host: string,
  options: { allowInternal?: boolean } = {},
): HostPolicyVerdict {
  const value = normalize(host);
  if (value === '') return { allowed: false, reason: 'a server name or address is required' };
  if (options.allowInternal) return { allowed: true };

  if (LOOPBACK_NAMES.has(value)) {
    return { allowed: false, reason: 'a loopback address reaches this platform rather than your database' };
  }
  if (METADATA_NAMES.includes(value)) {
    return {
      allowed: false,
      reason: 'that name belongs to the hosting environment, not to a database',
    };
  }

  const match = IPV4.exec(value);
  if (match) {
    const octets = match.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return { allowed: false, reason: 'that is not a valid address' };
    const verdict = ipv4Verdict(octets);
    if (verdict) return verdict;
    return { allowed: true };
  }

  // IPv6, in any of the ways it can be written.
  if (value.includes(':')) {
    const compact = value.replace(/^0+/, '');
    if (value === '::1' || compact === ':1' || /^(0+:){1,7}0*1$/.test(value)) {
      return {
        allowed: false,
        reason: 'a loopback address reaches this platform rather than your database',
      };
    }
    if (value === '::' || /^(0+:)+0*$/.test(value)) {
      return { allowed: false, reason: 'that address does not name a reachable server' };
    }
    // fe80::/10 — link-local, which is where instance metadata lives on IPv6.
    if (/^fe[89ab][0-9a-f]:/.test(value)) {
      return {
        allowed: false,
        reason: 'link-local addresses belong to the hosting environment, not to a database',
      };
    }
    // IPv4-mapped IPv6, which is the usual way to smuggle a loopback address past a name check.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
    if (mapped) return checkOutboundHost(mapped[1]!, options);
    return { allowed: true };
  }

  return { allowed: true };
}
