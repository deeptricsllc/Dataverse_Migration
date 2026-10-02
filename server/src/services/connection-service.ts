import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  ConnectionTestResultDto,
  EnvironmentDto,
  EnvironmentProvider,
  SqlConnectionConfig,
  SqlConnectionType,
} from '../../../shared/domain';
import type { AppConfig } from '../config';
import type { AppDb } from '../db/client';
import {
  connectionSecrets,
  environmentAccess,
  environments,
  migrationPlans,
  migrationRuns,
} from '../db/schema';
import type { ConnectionFactory } from '../dataverse/factory';
import { toDataverseError } from '../dataverse/errors';
import { AppError, badRequest, notFound } from '../lib/errors';
import { checkOutboundHost } from '../lib/network-policy';
import { requireAdmin } from './authorization';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import { toEnvironmentDto, type EnvironmentRow } from './environment-service';

export interface SqlConnectionInput {
  displayName: string;
  /**
   * Explicitly the hand-configured kinds, not "anything but Dataverse": a future connection type
   * that is not a SQL server would otherwise be admitted here and then asked for a host and port.
   */
  connectionType: SqlConnectionType;
  host: string;
  port: number;
  database: string;
  authType: SqlConnectionConfig['authType'];
  username: string | null;
  /** Plaintext, only ever in memory: encrypted before it is stored and never read back. */
  password?: string | null;
  encrypt: boolean;
  trustServerCertificate: boolean;
  schemas: string[];
  transport: SqlConnectionConfig['transport'];
}

/**
 * Manages SQL Server / Azure SQL connections: creation, credential storage, connection testing
 * and deletion.
 *
 * Credentials are encrypted with the application secret box and stored in their own table. They
 * are never returned by the API, never written to a log, and never copied into a migration run
 * snapshot — a snapshot records which connection was used, not how to authenticate to it.
 */
/** The URL scheme and provider each hand-configured connection kind records. */
const SCHEMES: Record<SqlConnectionType, string> = {
  SQL_SERVER: 'sqlserver',
  AZURE_SQL: 'azuresql',
  POSTGRES: 'postgresql',
  MYSQL: 'mysql',
};
const PROVIDERS: Record<SqlConnectionType, EnvironmentProvider> = {
  SQL_SERVER: 'sqlserver',
  AZURE_SQL: 'azuresql',
  POSTGRES: 'postgres',
  MYSQL: 'mysql',
};

export class ConnectionService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDb,
    private readonly connections: ConnectionFactory,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  private toConfig(input: SqlConnectionInput): SqlConnectionConfig {
    if (!input.host.trim()) throw badRequest('A server/host is required');
    /**
     * Where this deployment is willing to dial. The host comes from a signed-in user and the server
     * connects to it, so without this a tenant could reach the hosting environment's own loopback
     * services or its instance metadata endpoint. Private ranges are still allowed: a database on 10.x
     * behind a tunnel is the normal case rather than an attack.
     */
    const verdict = checkOutboundHost(input.host, {
      allowInternal: this.config.ALLOW_INTERNAL_CONNECTIONS,
    });
    if (!verdict.allowed) {
      throw badRequest(`This environment will not connect to that server: ${verdict.reason}.`);
    }
    if (!input.database.trim()) throw badRequest('A database name is required');
    if (input.authType === 'SQL_LOGIN' && !input.username?.trim()) {
      throw badRequest('A username is required for SQL authentication');
    }
    return {
      host: input.host.trim(),
      port: input.port,
      database: input.database.trim(),
      authType: input.authType,
      username: input.username?.trim() || null,
      encrypt: input.encrypt,
      trustServerCertificate: input.trustServerCertificate,
      transport: input.transport,
      schemas: input.schemas.map((s) => s.trim()).filter(Boolean),
    };
  }

  /** A stable, human-readable identifier. Used as the unique key per organization. */
  private urlFor(type: SqlConnectionType, c: SqlConnectionConfig): string {
    const scheme = SCHEMES[type];
    return `${scheme}://${c.host}:${c.port}/${c.database}`;
  }

  async create(ctx: RequestContext, input: SqlConnectionInput): Promise<EnvironmentDto> {
    const config = this.toConfig(input);
    const url = this.urlFor(input.connectionType, config);
    const [existing] = await this.db
      .select({ id: environments.id })
      .from(environments)
      .where(and(eq(environments.organizationId, ctx.organizationId), eq(environments.url, url)));
    if (existing)
      throw new AppError(409, 'CONNECTION_EXISTS', 'A connection to this database already exists');

    const [row] = await this.db
      .insert(environments)
      .values({
        organizationId: ctx.organizationId,
        provider: PROVIDERS[input.connectionType],
        connectionType: input.connectionType,
        sqlConfig: config,
        displayName: input.displayName.trim() || `${config.host}/${config.database}`,
        url,
        uniqueName: config.database,
        environmentType: null,
        dataverseAvailable: false,
      })
      .returning();
    await this.db
      .insert(environmentAccess)
      .values({ userId: ctx.userId, environmentId: row.id })
      .onConflictDoNothing();
    if (input.password) await this.storeSecret(ctx, row.id, input.password);

    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'CONNECTION_CREATED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: row.id,
      requestId: ctx.requestId,
      // Deliberately records the target, never the credential.
      details: { connectionType: input.connectionType, host: config.host, database: config.database },
    });
    return toEnvironmentDto(row, Boolean(input.password));
  }

  async update(
    ctx: RequestContext,
    connectionId: string,
    input: SqlConnectionInput,
  ): Promise<EnvironmentDto> {
    const env = await this.loadSql(ctx, connectionId);
    const config = this.toConfig(input);
    const [row] = await this.db
      .update(environments)
      .set({
        displayName: input.displayName.trim() || env.displayName,
        sqlConfig: config,
        url: this.urlFor(env.connectionType, config),
        uniqueName: config.database,
        // The stored status refers to the previous settings, so it is no longer meaningful.
        connectionStatus: 'UNKNOWN',
        connectionMessage: null,
      })
      .where(eq(environments.id, env.id))
      .returning();
    // An omitted password means "keep the stored one", not "clear it".
    if (input.password) await this.storeSecret(ctx, env.id, input.password);
    const hasSecret = await this.hasSecret(env.id);
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'CONNECTION_UPDATED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: env.id,
      requestId: ctx.requestId,
      details: { host: config.host, database: config.database, passwordChanged: Boolean(input.password) },
    });
    return toEnvironmentDto(row, hasSecret);
  }

  private async storeSecret(ctx: RequestContext, environmentId: string, password: string) {
    const ciphertext = this.connections.encryptSecret(password);
    await this.db
      .insert(connectionSecrets)
      .values({ environmentId, ciphertext, updatedByUserId: ctx.userId })
      .onConflictDoUpdate({
        target: connectionSecrets.environmentId,
        set: { ciphertext, updatedByUserId: ctx.userId, updatedAt: new Date() },
      });
  }

  private async hasSecret(environmentId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: connectionSecrets.environmentId })
      .from(connectionSecrets)
      .where(eq(connectionSecrets.environmentId, environmentId));
    return Boolean(row);
  }

  /**
   * A hand-configured connection row, with its kind narrowed. The guard below is what makes the
   * narrowing true rather than asserted.
   */
  private async loadSql(
    ctx: RequestContext,
    connectionId: string,
  ): Promise<EnvironmentRow & { connectionType: SqlConnectionType }> {
    const [row] = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.id, connectionId), eq(environments.organizationId, ctx.organizationId)));
    if (!row) throw notFound('Connection');
    if (row.connectionType === 'DATAVERSE') {
      throw badRequest('Dataverse environments are managed through discovery, not connection settings');
    }
    return row as EnvironmentRow & { connectionType: SqlConnectionType };
  }

  /**
   * Tests a connection and records the result. Read-only: it reads the server version and the
   * catalog, and never inserts, updates or deletes anything to prove connectivity.
   */
  async test(ctx: RequestContext, connectionId: string): Promise<ConnectionTestResultDto> {
    const [row] = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.id, connectionId), eq(environments.organizationId, ctx.organizationId)));
    if (!row) throw notFound('Connection');
    const connector = await this.connections.connectorFor(row, ctx.userId, { requestId: ctx.requestId });
    let result: ConnectionTestResultDto;
    try {
      result = await connector.testConnection();
    } catch (err) {
      const e = toDataverseError(err);
      this.logger.warn({ connectionId, code: e.code }, 'Connection test failed');
      result = {
        ok: false,
        summary: e.message,
        checks: [{ key: 'network', label: 'Server reachable', status: 'FAIL', message: e.message }],
      };
    } finally {
      await connector.dispose?.();
    }
    await this.db
      .update(environments)
      .set({
        connectionStatus: result.ok ? 'CONNECTED' : 'FAILED',
        connectionMessage: result.summary,
        lastTestedAt: new Date(),
      })
      .where(eq(environments.id, row.id));
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'CONNECTION_TESTED',
      outcome: result.ok ? 'SUCCESS' : 'FAILURE',
      sourceEnvironmentId: row.id,
      requestId: ctx.requestId,
      details: { summary: result.summary },
    });
    return result;
  }

  /** Tests settings that have not been saved yet, so a user can fix them before storing anything. */
  async testUnsaved(ctx: RequestContext, input: SqlConnectionInput): Promise<ConnectionTestResultDto> {
    const config = this.toConfig(input);
    const connector = this.connections.sqlConnectorFor(input.connectionType, config, input.password ?? null);
    try {
      return await connector.testConnection();
    } catch (err) {
      const e = toDataverseError(err);
      this.logger.warn({ code: e.code, requestId: ctx.requestId }, 'Connection test failed');
      return {
        ok: false,
        summary: e.message,
        checks: [{ key: 'network', label: 'Server reachable', status: 'FAIL', message: e.message }],
      };
    } finally {
      // Optional on the contract: a connector without a pool has nothing to release.
      await connector.dispose?.();
    }
  }

  /**
   * Deletes a connection's stored configuration and credential.
   *
   * Migration history is deliberately preserved: runs, validations and the record identity map
   * reference the connection, and deleting what a migration did would destroy the audit trail.
   * A connection that is still referenced is therefore refused rather than cascading.
   */
  async remove(ctx: RequestContext, connectionId: string): Promise<{ deleted: true }> {
    // Deleting a connection destroys a stored credential and the configuration other people's plans
    // depend on, so it outlives the task and needs an administrator.
    requireAdmin(ctx, 'Deleting a connection');
    const env = await this.loadSql(ctx, connectionId);
    const [usedByRun] = await this.db
      .select({ id: migrationRuns.id })
      .from(migrationRuns)
      .where(eq(migrationRuns.sourceEnvironmentId, env.id))
      .limit(1);
    const [usedByRunTarget] = await this.db
      .select({ id: migrationRuns.id })
      .from(migrationRuns)
      .where(eq(migrationRuns.targetEnvironmentId, env.id))
      .limit(1);
    const [usedByPlan] = await this.db
      .select({ id: migrationPlans.id })
      .from(migrationPlans)
      .where(eq(migrationPlans.sourceEnvironmentId, env.id))
      .limit(1);
    if (usedByRun || usedByRunTarget || usedByPlan) {
      throw new AppError(
        409,
        'CONNECTION_IN_USE',
        'This connection is referenced by a migration plan or run. Its history is kept, so the connection cannot be deleted.',
      );
    }
    await this.db.delete(connectionSecrets).where(eq(connectionSecrets.environmentId, env.id));
    await this.db.delete(environments).where(eq(environments.id, env.id));
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'CONNECTION_DELETED',
      outcome: 'SUCCESS',
      requestId: ctx.requestId,
      details: { displayName: env.displayName, connectionType: env.connectionType },
    });
    return { deleted: true };
  }
}
