import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { EnvironmentDto, WorkspaceDto } from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { environmentAccess, environments, userPreferences } from '../db/schema';
import { DataverseError, toDataverseError } from '../dataverse/errors';
import type { ConnectionFactory } from '../dataverse/factory';
import { AppError, badRequest, notFound } from '../lib/errors';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';

export type EnvironmentRow = typeof environments.$inferSelect;

export function toEnvironmentDto(e: EnvironmentRow): EnvironmentDto {
  return {
    id: e.id,
    provider: e.provider,
    displayName: e.displayName,
    url: e.url,
    organizationId: e.dataverseOrganizationId,
    environmentId: e.environmentId,
    uniqueName: e.uniqueName,
    environmentType: e.environmentType,
    region: e.region,
    version: e.version,
    state: e.state,
    dataverseAvailable: e.dataverseAvailable,
    connectionStatus: e.connectionStatus,
    connectionMessage: e.connectionMessage,
    lastTestedAt: e.lastTestedAt?.toISOString() ?? null,
    lastDiscoveredAt: e.lastDiscoveredAt?.toISOString() ?? null,
  };
}

/** Converts integration errors into user-facing API errors without leaking internals. */
export function integrationError(err: unknown, action: string): AppError {
  if (err instanceof AppError) return err;
  const e = toDataverseError(err);
  const status =
    e.code === 'FORBIDDEN' ? 403 : e.code === 'AUTH_REQUIRED' ? 401 : e.code === 'NOT_FOUND' ? 404 : 502;
  return new AppError(status, `DATAVERSE_${e.code}`, `${action} failed: ${e.message}`);
}

export class EnvironmentService {
  constructor(
    private readonly db: AppDb,
    private readonly connections: ConnectionFactory,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  async list(ctx: RequestContext): Promise<EnvironmentDto[]> {
    const rows = await this.db
      .select({ env: environments })
      .from(environments)
      .innerJoin(
        environmentAccess,
        and(eq(environmentAccess.environmentId, environments.id), eq(environmentAccess.userId, ctx.userId)),
      )
      .where(eq(environments.organizationId, ctx.organizationId))
      .orderBy(environments.displayName);
    return rows.map((r) => toEnvironmentDto(r.env));
  }

  /** Loads an environment the current user may access (organization + discovery scoped). */
  async getAccessible(ctx: RequestContext, environmentId: string): Promise<EnvironmentRow> {
    const [row] = await this.db
      .select({ env: environments })
      .from(environments)
      .innerJoin(
        environmentAccess,
        and(eq(environmentAccess.environmentId, environments.id), eq(environmentAccess.userId, ctx.userId)),
      )
      .where(and(eq(environments.id, environmentId), eq(environments.organizationId, ctx.organizationId)));
    if (!row) throw notFound('Environment');
    return row.env;
  }

  /** Loads an environment by id within an organization (used by background jobs). */
  async getInOrganization(organizationId: string, environmentId: string): Promise<EnvironmentRow> {
    const [row] = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.id, environmentId), eq(environments.organizationId, organizationId)));
    if (!row) throw notFound('Environment');
    return row;
  }

  async discover(ctx: RequestContext): Promise<EnvironmentDto[]> {
    const provider = this.connections.discoveryProvider(ctx.isDemoOrg, ctx.userId);
    let discovered;
    try {
      discovered = await provider.discover();
    } catch (err) {
      this.logger.warn(
        { requestId: ctx.requestId, errorCode: toDataverseError(err).code },
        'Environment discovery failed',
      );
      await this.audit.record({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        action: 'ENVIRONMENTS_DISCOVERED',
        outcome: 'FAILURE',
        requestId: ctx.requestId,
        details: {
          error: err instanceof AppError || err instanceof DataverseError ? err.message : 'Discovery failed',
        },
      });
      throw integrationError(err, 'Environment discovery');
    }
    const now = new Date();
    for (const d of discovered) {
      const [env] = await this.db
        .insert(environments)
        .values({
          organizationId: ctx.organizationId,
          provider: d.provider,
          displayName: d.displayName,
          url: d.url,
          apiUrl: d.apiUrl,
          dataverseOrganizationId: d.organizationId,
          environmentId: d.environmentId,
          uniqueName: d.uniqueName,
          environmentType: d.environmentType,
          region: d.region,
          version: d.version,
          state: d.state,
          dataverseAvailable: d.dataverseAvailable,
          lastDiscoveredAt: now,
        })
        .onConflictDoUpdate({
          target: [environments.organizationId, environments.url],
          set: {
            displayName: d.displayName,
            apiUrl: d.apiUrl,
            dataverseOrganizationId: d.organizationId,
            environmentId: d.environmentId,
            uniqueName: d.uniqueName,
            environmentType: d.environmentType,
            region: d.region,
            version: d.version,
            state: d.state,
            dataverseAvailable: d.dataverseAvailable,
            lastDiscoveredAt: now,
          },
        })
        .returning();
      await this.db
        .insert(environmentAccess)
        .values({ userId: ctx.userId, environmentId: env.id, lastSeenAt: now })
        .onConflictDoUpdate({
          target: [environmentAccess.userId, environmentAccess.environmentId],
          set: { lastSeenAt: now },
        });
    }
    // Revoke access rows for environments no longer returned for this user.
    const current = await this.list(ctx);
    const discoveredUrls = new Set(discovered.map((d) => d.url));
    const stale = current.filter((e) => !discoveredUrls.has(e.url)).map((e) => e.id);
    if (stale.length) {
      await this.db
        .delete(environmentAccess)
        .where(
          and(eq(environmentAccess.userId, ctx.userId), inArray(environmentAccess.environmentId, stale)),
        );
    }
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'ENVIRONMENTS_DISCOVERED',
      outcome: 'SUCCESS',
      requestId: ctx.requestId,
      details: { count: discovered.length },
    });
    return this.list(ctx);
  }

  async testConnection(ctx: RequestContext, environmentId: string): Promise<EnvironmentDto> {
    const env = await this.getAccessible(ctx, environmentId);
    const conn = this.connections.forEnvironment(env, ctx.userId, { requestId: ctx.requestId });
    let status: 'CONNECTED' | 'FAILED' = 'CONNECTED';
    let message: string;
    try {
      const who = await conn.whoAmI();
      message = `Connected as Dataverse user ${who.userId}`;
    } catch (err) {
      status = 'FAILED';
      const e = err instanceof AppError ? err : toDataverseError(err);
      message = e.message;
      this.logger.warn(
        { requestId: ctx.requestId, environmentId, code: (e as { code?: string }).code },
        'Connection test failed',
      );
    }
    const [updated] = await this.db
      .update(environments)
      .set({ connectionStatus: status, connectionMessage: message, lastTestedAt: new Date() })
      .where(eq(environments.id, env.id))
      .returning();
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'ENVIRONMENT_CONNECTION_TESTED',
      outcome: status === 'CONNECTED' ? 'SUCCESS' : 'FAILURE',
      sourceEnvironmentId: env.id,
      requestId: ctx.requestId,
      details: { environment: env.displayName, message },
    });
    return toEnvironmentDto(updated);
  }

  async getWorkspace(ctx: RequestContext): Promise<WorkspaceDto> {
    const [pref] = await this.db.select().from(userPreferences).where(eq(userPreferences.userId, ctx.userId));
    const load = async (id: string | null | undefined) => {
      if (!id) return null;
      try {
        return toEnvironmentDto(await this.getAccessible(ctx, id));
      } catch {
        return null;
      }
    };
    return { source: await load(pref?.sourceEnvironmentId), target: await load(pref?.targetEnvironmentId) };
  }

  async setWorkspace(
    ctx: RequestContext,
    input: { sourceEnvironmentId: string | null; targetEnvironmentId: string | null },
  ): Promise<WorkspaceDto> {
    if (input.sourceEnvironmentId && input.sourceEnvironmentId === input.targetEnvironmentId) {
      throw badRequest('Source and target must be different environments');
    }
    if (input.sourceEnvironmentId) await this.getAccessible(ctx, input.sourceEnvironmentId);
    if (input.targetEnvironmentId) await this.getAccessible(ctx, input.targetEnvironmentId);
    await this.db
      .insert(userPreferences)
      .values({
        userId: ctx.userId,
        sourceEnvironmentId: input.sourceEnvironmentId,
        targetEnvironmentId: input.targetEnvironmentId,
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          sourceEnvironmentId: input.sourceEnvironmentId,
          targetEnvironmentId: input.targetEnvironmentId,
          updatedAt: sql`now()`,
        },
      });
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'WORKSPACE_SELECTED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: input.sourceEnvironmentId,
      targetEnvironmentId: input.targetEnvironmentId,
      requestId: ctx.requestId,
    });
    return this.getWorkspace(ctx);
  }
}
