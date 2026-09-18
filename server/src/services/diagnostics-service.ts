import type { Logger } from 'pino';
import type { DiagnosticCheckDto, DiagnosticsReportDto, DiagnosticStatus } from '../../../shared/domain';
import type { MicrosoftIdentityService } from '../auth/microsoft-identity';
import type { AppConfig } from '../config';
import { toDataverseError } from '../dataverse/errors';
import type { ConnectionFactory } from '../dataverse/factory';
import { AppError } from '../lib/errors';
import type { RequestContext } from './context';
import type { EnvironmentService } from './environment-service';
import type { MetadataService } from './metadata-service';
import type { PrincipalService } from './principal-service';
import { envRef } from './env-ref';

/**
 * Read-only connection diagnostics for a real Microsoft tenant. Every check performs reads only;
 * no check ever writes to Dataverse, and no token or raw response is exposed.
 */
export class DiagnosticsService {
  constructor(
    private readonly config: AppConfig,
    private readonly environmentsSvc: EnvironmentService,
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionFactory,
    private readonly principals: PrincipalService,
    private readonly identity: MicrosoftIdentityService,
    private readonly logger: Logger,
  ) {}

  async run(
    ctx: RequestContext,
    input: { sourceEnvironmentId?: string; targetEnvironmentId?: string; authProvider: 'microsoft' | 'demo' },
  ): Promise<DiagnosticsReportDto> {
    const checks: DiagnosticCheckDto[] = [];
    const add = (c: DiagnosticCheckDto) => checks.push(c);
    const timed = async (
      key: string,
      label: string,
      fn: () => Promise<{ status: DiagnosticStatus; message: string; resolution?: string | null }>,
    ) => {
      const started = Date.now();
      try {
        const result = await fn();
        add({ key, label, ...result, durationMs: Date.now() - started });
      } catch (err) {
        add({ key, label, ...this.describeFailure(err), durationMs: Date.now() - started });
      }
    };

    add({
      key: 'authentication',
      label: 'Authentication',
      status: 'PASS',
      message:
        input.authProvider === 'microsoft'
          ? `Signed in with Microsoft Entra ID as ${ctx.displayName}`
          : `Demo session for ${ctx.displayName} (no Microsoft tenant is connected)`,
    });

    if (input.authProvider === 'microsoft') {
      await timed('token', 'Token acquisition', async () => {
        await this.identity.getResourceToken(ctx.userId, this.config.DATAVERSE_DISCOVERY_URL);
        return {
          status: 'PASS',
          message: 'A delegated access token for the Dataverse Discovery Service was acquired silently',
        };
      });
    } else {
      add({
        key: 'token',
        label: 'Token acquisition',
        status: 'NOT_TESTED',
        message: 'Demo sessions do not use Microsoft tokens',
      });
    }

    await timed('discovery', 'Environment discovery', async () => {
      const provider = this.connections.discoveryProvider(ctx.isDemoOrg, ctx.userId);
      const envs = await provider.discover();
      return envs.length
        ? { status: 'PASS', message: `${envs.length} environment(s) visible to this account` }
        : {
            status: 'WARN',
            message: 'No environments were returned',
            resolution:
              'The account may have no Dataverse security role, may be filtered out by an environment security group, or may only be a delegated administrator.',
          };
    });

    const loadEnv = async (id: string | undefined) => {
      if (!id) return null;
      try {
        return await this.environmentsSvc.getAccessible(ctx, id);
      } catch {
        return null;
      }
    };
    const source = await loadEnv(input.sourceEnvironmentId);
    const target = await loadEnv(input.targetEnvironmentId);

    for (const [role, env] of [
      ['Source', source],
      ['Target', target],
    ] as const) {
      const key = `${role.toLowerCase()}Connection`;
      if (!env) {
        add({
          key,
          label: `${role} connection`,
          status: 'NOT_TESTED',
          message: `No ${role.toLowerCase()} environment is selected`,
        });
        continue;
      }
      await timed(key, `${role} connection`, async () => {
        const conn = await this.connections.connectorFor(env, ctx.userId, { requestId: ctx.requestId });
        const who = await conn.whoAmI();
        return { status: 'PASS', message: `${env.displayName}: connected as Dataverse user ${who.userId}` };
      });
    }

    const probe = target ?? source;
    if (!probe) {
      for (const [key, label] of [
        ['metadata', 'Metadata access'],
        ['records', 'Record read permission'],
        ['users', 'User discovery'],
      ]) {
        add({ key, label, status: 'NOT_TESTED', message: 'Select a source and target environment first' });
      }
    } else {
      await timed('metadata', 'Metadata access', async () => {
        const conn = await this.connections.connectorFor(probe, ctx.userId, { requestId: ctx.requestId });
        const catalog = await this.metadata.getCatalog(probe.id, conn, true);
        const sample = catalog.find((t) => t.logicalName === 'account') ?? catalog[0];
        if (!sample) return { status: 'WARN', message: 'The table catalog came back empty' };
        const table = await this.metadata.getTable(probe.id, conn, sample.logicalName, true);
        return {
          status: 'PASS',
          message: `${catalog.length} tables readable; ${sample.logicalName} exposes ${table?.attributes.length ?? 0} columns, ${table?.keys.length ?? 0} alternate key(s)`,
        };
      });

      await timed('records', 'Record read permission', async () => {
        const conn = await this.connections.connectorFor(probe, ctx.userId, { requestId: ctx.requestId });
        const catalog = await this.metadata.getCatalog(probe.id, conn);
        const sample = catalog.find((t) => t.logicalName === 'account') ?? catalog[0];
        if (!sample) return { status: 'NOT_TESTED', message: 'No table available to read' };
        const count = await conn.countRecords(sample);
        return {
          status: 'PASS',
          message: `${sample.logicalName}: ${count.count.toLocaleString()} record(s)${count.approximate ? ' (snapshot count)' : ''}`,
        };
      });

      await timed('users', 'User discovery', async () => {
        const conn = await this.connections.connectorFor(probe, ctx.userId, { requestId: ctx.requestId });
        const users = await conn.listPrincipals('systemuser');
        return users.length
          ? { status: 'PASS', message: `${users.length} user(s) readable in ${probe.displayName}` }
          : {
              status: 'WARN',
              message: 'No users were returned',
              resolution: 'Reading systemuser records is required for ownership and audit preservation.',
            };
      });
    }

    if (source && target) {
      await timed('impersonation', 'Impersonation privilege', async () => {
        const result = await this.principals.checkImpersonation(ctx, source.id, target.id);
        return result.canImpersonate
          ? { status: 'PASS', message: result.message }
          : {
              status: 'WARN',
              message: result.message,
              resolution:
                'Only needed for the PRESERVE_ATTRIBUTION audit policy. Microsoft requires prvActOnBehalfOfAnotherUser to be assigned directly, not through a team.',
            };
      });
    } else {
      add({
        key: 'impersonation',
        label: 'Impersonation privilege',
        status: 'NOT_TESTED',
        message: 'Select a source and target environment, then load the user mapping',
      });
    }

    add({
      key: 'write',
      label: 'Write permission',
      status: 'NOT_TESTED',
      message: this.config.REAL_TENANT_READ_ONLY
        ? 'REAL_TENANT_READ_ONLY is enabled: Dataverse writes are disabled for this deployment and are never tested'
        : 'Write permission is never probed automatically; it is exercised by a controlled migration run',
    });

    return {
      ranAt: new Date().toISOString(),
      mode: { demoMode: this.config.DEMO_MODE, realTenantReadOnly: this.config.REAL_TENANT_READ_ONLY },
      sourceEnvironment: source ? envRef(source) : null,
      targetEnvironment: target ? envRef(target) : null,
      checks,
    };
  }

  /** Turns an error into an actionable line without leaking tokens or raw payloads. */
  private describeFailure(err: unknown): {
    status: DiagnosticStatus;
    message: string;
    resolution?: string | null;
  } {
    if (err instanceof AppError) {
      return {
        status: 'FAIL',
        message: err.message,
        resolution:
          err.code === 'REAUTH_REQUIRED'
            ? 'Sign out and sign in again with Microsoft; consent may have been revoked or the refresh token expired.'
            : null,
      };
    }
    const e = toDataverseError(err);
    const resolutions: Record<string, string> = {
      FORBIDDEN:
        'The signed-in user lacks the required Dataverse privilege or security role in this environment.',
      AUTH_REQUIRED: 'Sign in again: the delegated token was rejected.',
      NOT_FOUND: 'The requested resource does not exist in this environment.',
      THROTTLED: 'Dataverse service protection limits were hit; retry in a few minutes.',
      NETWORK: 'The Dataverse endpoint could not be reached from this deployment.',
    };
    this.logger.warn({ code: e.code, status: e.status }, 'Diagnostic check failed');
    return {
      status: 'FAIL',
      message: `${e.code}${e.status ? ` (HTTP ${e.status})` : ''}: ${e.message.slice(0, 300)}`,
      resolution: resolutions[e.code] ?? null,
    };
  }
}
