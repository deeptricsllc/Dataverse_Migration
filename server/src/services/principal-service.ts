import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  ImpersonationCapabilityDto,
  PrincipalDto,
  PrincipalMappingDto,
  PrincipalMappingSummaryDto,
  PrincipalMatchStatus,
  PrincipalTable,
} from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { principalDirectory, principalMaps } from '../db/schema';
import type { ConnectionFactory } from '../dataverse/factory';
import { badRequest, notFound } from '../lib/errors';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import { integrationError, type EnvironmentRow, type EnvironmentService } from './environment-service';

const PRINCIPAL_TABLES: PrincipalTable[] = ['systemuser', 'team', 'businessunit'];
const DIRECTORY_TTL_MS = 60 * 60 * 1000;

interface Match {
  targetId: string | null;
  method: string | null;
  confidence: number;
  note: string | null;
}

/**
 * Matches a source principal to a target principal. Entra object id is authoritative; login and
 * email are strong; an exact name match is weaker and flagged for review. Nothing is guessed
 * beyond these rules.
 */
export function matchPrincipal(source: PrincipalDto, targets: PrincipalDto[]): Match {
  const norm = (v: string | null | undefined) => (v ? v.trim().toLowerCase() : null);
  const byEntra =
    source.entraObjectId && targets.find((t) => norm(t.entraObjectId) === norm(source.entraObjectId));
  if (byEntra) return { targetId: byEntra.id, method: 'ENTRA_OBJECT_ID', confidence: 100, note: null };
  const byLogin = source.login && targets.find((t) => norm(t.login) === norm(source.login));
  if (byLogin) return { targetId: byLogin.id, method: 'LOGIN', confidence: 95, note: null };
  const byEmail = source.email && targets.find((t) => norm(t.email) === norm(source.email));
  if (byEmail) return { targetId: byEmail.id, method: 'EMAIL', confidence: 90, note: null };
  const byName = targets.filter((t) => norm(t.name) === norm(source.name));
  if (byName.length === 1) {
    return {
      targetId: byName[0].id,
      method: 'NAME',
      confidence: 70,
      note: 'Matched on display name only; confirm before migrating.',
    };
  }
  if (byName.length > 1) {
    return {
      targetId: null,
      method: null,
      confidence: 0,
      note: `${byName.length} target users share this name; choose one manually.`,
    };
  }
  return { targetId: null, method: null, confidence: 0, note: 'No matching user in the target environment.' };
}

/**
 * Source -> target mapping of users, teams and business units for one environment pair.
 * Record identifiers differ between environments, so ownership, created-by/modified-by and any
 * lookup pointing at a principal can only be migrated through this map.
 */
export class PrincipalService {
  constructor(
    private readonly db: AppDb,
    private readonly environmentsSvc: EnvironmentService,
    private readonly connections: ConnectionFactory,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  private async directory(
    env: EnvironmentRow,
    userId: string,
    opts: { refresh?: boolean; requestId?: string } = {},
  ): Promise<Record<PrincipalTable, PrincipalDto[]>> {
    const cached = await this.db
      .select()
      .from(principalDirectory)
      .where(eq(principalDirectory.environmentId, env.id));
    const fresh = cached.length > 0 && Date.now() - cached[0].fetchedAt.getTime() < DIRECTORY_TTL_MS;
    if (fresh && !opts.refresh) {
      const out = { systemuser: [], team: [], businessunit: [] } as Record<PrincipalTable, PrincipalDto[]>;
      for (const row of cached) out[row.logicalName].push(row.data);
      for (const list of Object.values(out)) list.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    }
    const conn = this.connections.forEnvironment(env, userId, { requestId: opts.requestId });
    const out = { systemuser: [], team: [], businessunit: [] } as Record<PrincipalTable, PrincipalDto[]>;
    for (const table of PRINCIPAL_TABLES) {
      try {
        out[table] = await conn.listPrincipals(table);
      } catch (err) {
        this.logger.warn(
          { environmentId: env.id, table, err: (err as Error).message },
          'Principal directory unavailable',
        );
        if (table === 'systemuser') throw err;
      }
    }
    await this.db.delete(principalDirectory).where(eq(principalDirectory.environmentId, env.id));
    const rows = PRINCIPAL_TABLES.flatMap((table) =>
      out[table].map((p) => ({
        environmentId: env.id,
        logicalName: table,
        principalId: p.id,
        data: p,
        fetchedAt: new Date(),
      })),
    );
    for (let i = 0; i < rows.length; i += 200) {
      if (rows.length)
        await this.db
          .insert(principalDirectory)
          .values(rows.slice(i, i + 200))
          .onConflictDoNothing();
    }
    return out;
  }

  /** Discovers both directories and (re)computes automatic matches, keeping manual decisions. */
  async refresh(
    ctx: RequestContext,
    sourceEnvironmentId: string,
    targetEnvironmentId: string,
    opts: { refreshDirectory?: boolean } = {},
  ): Promise<PrincipalMappingSummaryDto> {
    if (sourceEnvironmentId === targetEnvironmentId)
      throw badRequest('Source and target must be different environments');
    const source = await this.environmentsSvc.getAccessible(ctx, sourceEnvironmentId);
    const target = await this.environmentsSvc.getAccessible(ctx, targetEnvironmentId);
    try {
      const [sourceDir, targetDir] = await Promise.all([
        this.directory(source, ctx.userId, { refresh: opts.refreshDirectory, requestId: ctx.requestId }),
        this.directory(target, ctx.userId, { refresh: opts.refreshDirectory, requestId: ctx.requestId }),
      ]);
      const existing = await this.db
        .select()
        .from(principalMaps)
        .where(
          and(
            eq(principalMaps.sourceEnvironmentId, source.id),
            eq(principalMaps.targetEnvironmentId, target.id),
          ),
        );
      const manual = new Map(
        existing
          .filter((m) => m.status === 'MANUAL' || m.status === 'IGNORED')
          .map((m) => [`${m.logicalName}:${m.sourceId}`, m]),
      );
      for (const table of PRINCIPAL_TABLES) {
        for (const sourcePrincipal of sourceDir[table]) {
          const key = `${table}:${sourcePrincipal.id}`;
          if (manual.has(key)) continue;
          const match = matchPrincipal(sourcePrincipal, targetDir[table]);
          const status: PrincipalMatchStatus = match.targetId ? 'AUTO_MATCHED' : 'UNMATCHED';
          await this.db
            .insert(principalMaps)
            .values({
              organizationId: ctx.organizationId,
              sourceEnvironmentId: source.id,
              targetEnvironmentId: target.id,
              logicalName: table,
              sourceId: sourcePrincipal.id,
              targetId: match.targetId,
              status,
              matchMethod: match.method,
              confidence: match.confidence,
              note: match.note,
            })
            .onConflictDoUpdate({
              target: [
                principalMaps.sourceEnvironmentId,
                principalMaps.targetEnvironmentId,
                principalMaps.logicalName,
                principalMaps.sourceId,
              ],
              set: {
                targetId: match.targetId,
                status,
                matchMethod: match.method,
                confidence: match.confidence,
                note: match.note,
                updatedAt: new Date(),
              },
            });
        }
      }
      // Drop mappings for principals that no longer exist in the source directory, so stale
      // rows cannot resolve to users that were deleted or renamed away.
      for (const table of PRINCIPAL_TABLES) {
        const currentIds = sourceDir[table].map((p) => p.id);
        await this.db
          .delete(principalMaps)
          .where(
            and(
              eq(principalMaps.sourceEnvironmentId, source.id),
              eq(principalMaps.targetEnvironmentId, target.id),
              eq(principalMaps.logicalName, table),
              currentIds.length ? notInArray(principalMaps.sourceId, currentIds) : undefined,
            ),
          );
      }
      return this.list(ctx, source.id, target.id);
    } catch (err) {
      throw integrationError(err, 'Reading users and teams');
    }
  }

  async list(
    ctx: RequestContext,
    sourceEnvironmentId: string,
    targetEnvironmentId: string,
  ): Promise<PrincipalMappingSummaryDto> {
    const source = await this.environmentsSvc.getAccessible(ctx, sourceEnvironmentId);
    const target = await this.environmentsSvc.getAccessible(ctx, targetEnvironmentId);
    const [sourceRows, targetRows, maps] = await Promise.all([
      this.db.select().from(principalDirectory).where(eq(principalDirectory.environmentId, source.id)),
      this.db.select().from(principalDirectory).where(eq(principalDirectory.environmentId, target.id)),
      this.db
        .select()
        .from(principalMaps)
        .where(
          and(
            eq(principalMaps.sourceEnvironmentId, source.id),
            eq(principalMaps.targetEnvironmentId, target.id),
          ),
        ),
    ]);
    const targetById = new Map(targetRows.map((r) => [`${r.logicalName}:${r.principalId}`, r.data]));
    const mapByKey = new Map(maps.map((m) => [`${m.logicalName}:${m.sourceId}`, m]));
    const mappings: PrincipalMappingDto[] = sourceRows
      .map((row) => {
        const m = mapByKey.get(`${row.logicalName}:${row.principalId}`);
        return {
          logicalName: row.logicalName,
          source: row.data,
          target: m?.targetId ? (targetById.get(`${row.logicalName}:${m.targetId}`) ?? null) : null,
          status: (m?.status ?? 'UNMATCHED') as PrincipalMatchStatus,
          matchMethod: m?.matchMethod ?? null,
          confidence: m?.confidence ?? 0,
          note: m?.note ?? null,
        };
      })
      .sort(
        (a, b) => a.logicalName.localeCompare(b.logicalName) || a.source.name.localeCompare(b.source.name),
      );
    const targetPrincipals = { systemuser: [], team: [], businessunit: [] } as Record<
      PrincipalTable,
      PrincipalDto[]
    >;
    for (const row of targetRows) targetPrincipals[row.logicalName].push(row.data);
    for (const list of Object.values(targetPrincipals)) list.sort((a, b) => a.name.localeCompare(b.name));
    return {
      sourceEnvironment: { id: source.id, displayName: source.displayName, url: source.url },
      targetEnvironment: { id: target.id, displayName: target.displayName, url: target.url },
      refreshedAt: sourceRows[0]?.fetchedAt.toISOString() ?? null,
      counts: {
        total: mappings.length,
        matched: mappings.filter((m) => m.status === 'AUTO_MATCHED' || m.status === 'MANUAL').length,
        unmatched: mappings.filter((m) => m.status === 'UNMATCHED').length,
        manual: mappings.filter((m) => m.status === 'MANUAL').length,
        ignored: mappings.filter((m) => m.status === 'IGNORED').length,
      },
      mappings,
      targetPrincipals,
      capabilities: null,
    };
  }

  async setMapping(
    ctx: RequestContext,
    input: {
      sourceEnvironmentId: string;
      targetEnvironmentId: string;
      logicalName: PrincipalTable;
      sourceId: string;
      targetId: string | null;
      ignore?: boolean;
    },
  ): Promise<PrincipalMappingDto> {
    const source = await this.environmentsSvc.getAccessible(ctx, input.sourceEnvironmentId);
    const target = await this.environmentsSvc.getAccessible(ctx, input.targetEnvironmentId);
    const [exists] = await this.db
      .select()
      .from(principalDirectory)
      .where(
        and(
          eq(principalDirectory.environmentId, source.id),
          eq(principalDirectory.logicalName, input.logicalName),
          eq(principalDirectory.principalId, input.sourceId),
        ),
      );
    if (!exists) throw notFound('Source user');
    if (input.targetId) {
      const [targetPrincipal] = await this.db
        .select()
        .from(principalDirectory)
        .where(
          and(
            eq(principalDirectory.environmentId, target.id),
            eq(principalDirectory.logicalName, input.logicalName),
            eq(principalDirectory.principalId, input.targetId),
          ),
        );
      if (!targetPrincipal) throw badRequest('Target user does not exist in the target environment');
    }
    const status: PrincipalMatchStatus = input.ignore ? 'IGNORED' : input.targetId ? 'MANUAL' : 'UNMATCHED';
    await this.db
      .insert(principalMaps)
      .values({
        organizationId: ctx.organizationId,
        sourceEnvironmentId: source.id,
        targetEnvironmentId: target.id,
        logicalName: input.logicalName,
        sourceId: input.sourceId,
        targetId: input.ignore ? null : input.targetId,
        status,
        matchMethod: input.ignore ? null : input.targetId ? 'MANUAL' : null,
        confidence: input.targetId && !input.ignore ? 100 : 0,
        note: input.ignore ? 'Excluded by a user: records keep the migrating user instead.' : null,
        updatedByUserId: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [
          principalMaps.sourceEnvironmentId,
          principalMaps.targetEnvironmentId,
          principalMaps.logicalName,
          principalMaps.sourceId,
        ],
        set: {
          targetId: input.ignore ? null : input.targetId,
          status,
          matchMethod: input.ignore ? null : input.targetId ? 'MANUAL' : null,
          confidence: input.targetId && !input.ignore ? 100 : 0,
          note: input.ignore ? 'Excluded by a user: records keep the migrating user instead.' : null,
          updatedByUserId: ctx.userId,
          updatedAt: new Date(),
        },
      });
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'PRINCIPAL_MAPPING_CHANGED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: source.id,
      targetEnvironmentId: target.id,
      requestId: ctx.requestId,
      details: {
        logicalName: input.logicalName,
        sourceId: input.sourceId,
        targetId: input.targetId,
        ignored: Boolean(input.ignore),
      },
    });
    const summary = await this.list(ctx, source.id, target.id);
    return summary.mappings.find(
      (m) => m.logicalName === input.logicalName && m.source.id === input.sourceId,
    )!;
  }

  /** `${logicalName}:${sourceId}` -> target id, for the migration engine. */
  async resolutionMap(organizationId: string, sourceEnvironmentId: string, targetEnvironmentId: string) {
    const rows = await this.db
      .select()
      .from(principalMaps)
      .where(
        and(
          eq(principalMaps.organizationId, organizationId),
          eq(principalMaps.sourceEnvironmentId, sourceEnvironmentId),
          eq(principalMaps.targetEnvironmentId, targetEnvironmentId),
          inArray(principalMaps.status, ['AUTO_MATCHED', 'MANUAL']),
        ),
      );
    return new Map(
      rows.filter((r) => r.targetId).map((r) => [`${r.logicalName}:${r.sourceId}`, r.targetId!]),
    );
  }

  /** Verifies impersonation against the target using any mapped user (read-only). */
  async checkImpersonation(
    ctx: RequestContext,
    sourceEnvironmentId: string,
    targetEnvironmentId: string,
  ): Promise<ImpersonationCapabilityDto> {
    const target = await this.environmentsSvc.getAccessible(ctx, targetEnvironmentId);
    const map = await this.resolutionMap(ctx.organizationId, sourceEnvironmentId, target.id);
    // Only test with a user that still exists in the target directory.
    const known = new Set(
      (
        await this.db
          .select({ id: principalDirectory.principalId })
          .from(principalDirectory)
          .where(
            and(
              eq(principalDirectory.environmentId, target.id),
              eq(principalDirectory.logicalName, 'systemuser'),
            ),
          )
      ).map((r) => r.id),
    );
    const candidate = [...map.entries()].find(([k, v]) => k.startsWith('systemuser:') && known.has(v))?.[1];
    if (!candidate) {
      return {
        checkedAt: new Date().toISOString(),
        canImpersonate: false,
        message: 'No mapped target user to test with. Map at least one user first.',
      };
    }
    const conn = this.connections.forEnvironment(target, ctx.userId, { requestId: ctx.requestId });
    try {
      const result = await conn.checkImpersonation(candidate);
      return { checkedAt: new Date().toISOString(), canImpersonate: result.allowed, message: result.message };
    } catch (err) {
      throw integrationError(err, 'Impersonation check');
    }
  }
}
