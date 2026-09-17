import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE, safeReturnTo } from '../auth/auth-service';
import { seedDemoData } from '../dataverse/factory';
import { AppError, forbidden } from '../lib/errors';
import type { Services } from '../services/container';

const uuid = z.string().uuid();
const tableName = z.string().regex(/^[a-z0-9_]{1,128}$/);
const idParams = z.object({ id: uuid });
const page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function registerRoutes(app: FastifyInstance, s: Services) {
  const { config } = s;
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.COOKIE_SECURE,
    path: '/',
  };

  // ---------------------------------------------------------------------------
  // Health & auth
  // ---------------------------------------------------------------------------

  app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  app.get('/api/auth/config', async () => ({ microsoftEnabled: config.microsoftEnabled, demoEnabled: config.DEMO_MODE }));

  app.get('/api/auth/session', async (req) => {
    if (!req.session) return { user: null, csrfToken: null };
    return { user: req.session.user, csrfToken: req.session.csrfToken };
  });

  app.get('/api/auth/login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!config.microsoftEnabled) throw new AppError(404, 'MICROSOFT_NOT_CONFIGURED', 'Microsoft sign-in is not configured');
    const { returnTo } = z.object({ returnTo: z.string().max(500).optional() }).parse(req.query);
    const url = await s.auth.beginMicrosoftSignIn(safeReturnTo(returnTo));
    return reply.redirect(url);
  });

  app.get('/api/auth/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = z
      .object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional(), error_description: z.string().max(2000).optional() })
      .parse(req.query);
    if (q.error || !q.code || !q.state) {
      req.log.warn({ error: q.error }, 'Microsoft sign-in returned an error');
      const reason = encodeURIComponent(q.error === 'access_denied' ? 'Consent was declined or access was denied.' : 'Microsoft sign-in did not complete.');
      return reply.redirect(`/login?error=${reason}`);
    }
    try {
      const { userId, returnTo } = await s.auth.completeMicrosoftSignIn({ code: q.code, state: q.state }, req.id);
      const session = await s.auth.createSession(userId, req.headers['user-agent']);
      reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
      return reply.redirect(returnTo);
    } catch (err) {
      const message = err instanceof AppError ? err.message : 'Microsoft sign-in failed.';
      if (!(err instanceof AppError)) req.log.error({ err }, 'Microsoft sign-in failed');
      return reply.redirect(`/login?error=${encodeURIComponent(message)}`);
    }
  });

  app.post('/api/auth/demo-login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const userId = await s.auth.demoSignIn(req.id);
    const session = await s.auth.createSession(userId, req.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
    const resolved = await s.auth.resolveSession(session.token);
    return { user: resolved!.user, csrfToken: resolved!.csrfToken };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const provider = req.session!.user.authProvider;
    await s.audit.record({ organizationId: req.ctx.organizationId, userId: req.ctx.userId, action: 'AUTH_SIGN_OUT', outcome: 'SUCCESS', requestId: req.id });
    await s.auth.destroySession(req.session!.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { logoutUrl: provider === 'microsoft' && config.microsoftEnabled ? s.identity.logoutUrl() : null };
  });

  // ---------------------------------------------------------------------------
  // Environments & metadata
  // ---------------------------------------------------------------------------

  app.get('/api/environments', async (req) => s.environments.list(req.ctx));
  app.post('/api/environments/discover', async (req) => s.environments.discover(req.ctx));
  app.post('/api/environments/:id/test', async (req) => s.environments.testConnection(req.ctx, idParams.parse(req.params).id));

  app.get('/api/workspace', async (req) => s.environments.getWorkspace(req.ctx));
  app.put('/api/workspace', async (req) => {
    const body = z.object({ sourceEnvironmentId: uuid.nullable(), targetEnvironmentId: uuid.nullable() }).parse(req.body);
    return s.environments.setWorkspace(req.ctx, body);
  });

  app.get('/api/environments/:id/tables', async (req) => {
    const { id } = idParams.parse(req.params);
    const { refresh } = z.object({ refresh: z.enum(['true', 'false']).optional() }).parse(req.query);
    const env = await s.environments.getAccessible(req.ctx, id);
    const conn = s.connections.forEnvironment(env, req.ctx.userId, { requestId: req.id });
    return s.metadata.getCatalog(env.id, conn, refresh === 'true').catch((err) => {
      throw toApiError(err, 'Table discovery');
    });
  });

  app.get('/api/environments/:id/tables/:table', async (req) => {
    const { id, table } = z.object({ id: uuid, table: tableName }).parse(req.params);
    const { refresh } = z.object({ refresh: z.enum(['true', 'false']).optional() }).parse(req.query);
    const env = await s.environments.getAccessible(req.ctx, id);
    const conn = s.connections.forEnvironment(env, req.ctx.userId, { requestId: req.id });
    const meta = await s.metadata.getTable(env.id, conn, table, refresh === 'true').catch((err) => {
      throw toApiError(err, 'Metadata discovery');
    });
    if (!meta) throw new AppError(404, 'NOT_FOUND', 'Table not found');
    return meta;
  });

  app.get('/api/environments/:id/tables/:table/profile', async (req) => {
    const { id, table } = z.object({ id: uuid, table: tableName }).parse(req.params);
    return s.insights.profile(req.ctx, id, table);
  });

  // ---------------------------------------------------------------------------
  // Comparison
  // ---------------------------------------------------------------------------

  app.post('/api/comparisons', async (req) => {
    const body = z
      .object({
        sourceEnvironmentId: uuid,
        targetEnvironmentId: uuid,
        tables: z.array(tableName).max(1000).optional().nullable(),
        refreshMetadata: z.boolean().optional(),
      })
      .parse(req.body);
    return s.comparisons.create(req.ctx, body);
  });
  app.get('/api/comparisons', async (req) => {
    const q = z.object({ sourceEnvironmentId: uuid.optional(), targetEnvironmentId: uuid.optional() }).parse(req.query);
    return s.comparisons.list(req.ctx, q);
  });
  app.get('/api/comparisons/:id', async (req) => s.comparisons.get(req.ctx, idParams.parse(req.params).id));
  app.get('/api/comparisons/:id/tables', async (req) => s.comparisons.tables(req.ctx, idParams.parse(req.params).id));

  // ---------------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------------

  app.get('/api/migration/candidates', async (req) => {
    const q = z.object({ sourceEnvironmentId: uuid, targetEnvironmentId: uuid }).parse(req.query);
    return s.planning.candidates(req.ctx, q.sourceEnvironmentId, q.targetEnvironmentId);
  });

  app.put('/api/table-categories/:table', async (req) => {
    const { table } = z.object({ table: tableName }).parse(req.params);
    const { category } = z.object({ category: z.enum(['CONFIGURATION', 'REFERENCE', 'TRANSACTIONAL']).nullable() }).parse(req.body);
    await s.planning.setCategory(req.ctx, table, category);
    return { table, category };
  });

  app.get('/api/plans', async (req) => s.planning.list(req.ctx));
  app.post('/api/plans', async (req) => {
    const body = z
      .object({
        name: z.string().max(200).optional(),
        sourceEnvironmentId: uuid,
        targetEnvironmentId: uuid,
        tables: z.array(tableName).max(500),
      })
      .parse(req.body);
    return s.planning.create(req.ctx, body);
  });
  app.get('/api/plans/:id', async (req) => s.planning.get(req.ctx, idParams.parse(req.params).id));
  app.put('/api/plans/:id/tables', async (req) => {
    const { tables } = z.object({ tables: z.array(tableName).max(500) }).parse(req.body);
    return s.planning.updateSelection(req.ctx, idParams.parse(req.params).id, tables);
  });
  app.post('/api/plans/:id/revalidate', async (req) => s.planning.revalidate(req.ctx, idParams.parse(req.params).id));
  app.patch('/api/plans/:id/options', async (req) => {
    const patch = z
      .object({
        conflictStrategy: z.enum(['SKIP_EXISTING', 'CREATE_ONLY', 'UPSERT']).optional(),
        batchSize: z.number().int().min(1).max(500).optional(),
        maxRetries: z.number().int().min(0).max(10).optional(),
        bypassCustomBusinessLogic: z.boolean().optional(),
        suppressFlowTriggers: z.boolean().optional(),
        stopOnFirstError: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    return s.planning.updateOptions(req.ctx, idParams.parse(req.params).id, patch);
  });
  app.patch('/api/plans/:id/entities/:entityId', async (req) => {
    const { id, entityId } = z.object({ id: uuid, entityId: uuid }).parse(req.params);
    const body = z
      .object({ matchStrategy: z.enum(['PRIMARY_ID', 'ALTERNATE_KEY']), alternateKey: z.string().max(200).nullable() })
      .parse(req.body);
    return s.planning.updateEntity(req.ctx, id, entityId, body);
  });
  app.get('/api/plans/:id/entities/:entityId/mappings', async (req) => {
    const { id, entityId } = z.object({ id: uuid, entityId: uuid }).parse(req.params);
    return s.planning.mappings(req.ctx, id, entityId);
  });
  app.get('/api/plans/:id/entities/:entityId/suggestions', async (req) => {
    const { id, entityId } = z.object({ id: uuid, entityId: uuid }).parse(req.params);
    return s.planning.suggestions(req.ctx, id, entityId);
  });
  app.patch('/api/plans/:id/mappings/:mappingId', async (req) => {
    const { id, mappingId } = z.object({ id: uuid, mappingId: uuid }).parse(req.params);
    const body = z
      .discriminatedUnion('action', [
        z.object({ action: z.literal('MAP'), targetField: tableName }),
        z.object({ action: z.literal('IGNORE') }),
        z.object({ action: z.literal('UNMAP') }),
        z.object({ action: z.literal('RESET') }),
      ])
      .parse(req.body);
    return s.planning.updateMapping(req.ctx, id, mappingId, body);
  });
  app.post('/api/plans/:id/execute', async (req) => {
    const body = z
      .object({ confirmSourceName: z.string().max(300), confirmTargetName: z.string().max(300), acknowledgeWarnings: z.boolean() })
      .parse(req.body);
    return s.runs.start(req.ctx, idParams.parse(req.params).id, body);
  });

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  app.get('/api/runs', async (req) => s.runs.list(req.ctx));
  app.get('/api/runs/:id', async (req) => s.runs.get(req.ctx, idParams.parse(req.params).id));
  app.post('/api/runs/:id/:action', async (req) => {
    const { id, action } = z.object({ id: uuid, action: z.enum(['cancel', 'pause', 'resume', 'retry']) }).parse(req.params);
    return s.runs.control(req.ctx, id, action);
  });
  app.get('/api/runs/:id/errors', async (req) => {
    const { id } = idParams.parse(req.params);
    const q = page
      .extend({
        entity: tableName.optional(),
        kind: z.enum(['all', 'retryable', 'permanent']).optional(),
        severity: z.enum(['ERROR', 'WARNING']).optional(),
        includeResolved: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query);
    return s.runs.errors(req.ctx, id, { ...q, includeResolved: q.includeResolved === 'true' });
  });
  app.get('/api/runs/:id/records', async (req) => {
    const { id } = idParams.parse(req.params);
    const q = page.extend({ entity: tableName.optional(), outcome: z.enum(['CREATED', 'UPDATED', 'SKIPPED', 'FAILED']).optional() }).parse(req.query);
    return s.runs.records(req.ctx, id, q);
  });
  app.get('/api/runs/:id/rollback-preview', async (req) => s.runs.rollbackPreview(req.ctx, idParams.parse(req.params).id));

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  app.post('/api/validations', async (req) => {
    const body = z
      .object({
        migrationRunId: uuid.optional(),
        sourceEnvironmentId: uuid.optional(),
        targetEnvironmentId: uuid.optional(),
        tables: z.array(tableName).max(500).optional(),
      })
      .parse(req.body);
    return s.validation.start(req.ctx, body);
  });
  app.get('/api/validations', async (req) => s.validation.list(req.ctx));
  app.get('/api/validations/:id', async (req) => s.validation.get(req.ctx, idParams.parse(req.params).id));
  app.get('/api/validations/:id/differences', async (req) => {
    const { id } = idParams.parse(req.params);
    const q = page
      .extend({
        entity: tableName.optional(),
        type: z.enum(['MISSING_IN_TARGET', 'VALUE_MISMATCH', 'LOOKUP_MISMATCH', 'BROKEN_REFERENCE', 'PRE_EXISTING_DIFFERENCE']).optional(),
        outcome: z.enum(['PASS', 'WARNING', 'FAIL']).optional(),
      })
      .parse(req.query);
    return s.validation.differences(req.ctx, id, q);
  });

  // ---------------------------------------------------------------------------
  // Dashboard, audit, settings
  // ---------------------------------------------------------------------------

  app.get('/api/dashboard', async (req) => s.insights.dashboard(req.ctx));
  app.get('/api/audit', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return s.audit.list(req.ctx.organizationId, limit);
  });
  app.get('/api/settings', async (req) => ({
    organization: req.session!.user.organization,
    user: req.session!.user,
    demoMode: config.DEMO_MODE,
    microsoft: {
      enabled: config.microsoftEnabled,
      tenant: config.ENTRA_TENANT_ID,
      redirectUri: config.redirectUri,
      clientIdConfigured: Boolean(config.ENTRA_CLIENT_ID),
      discoveryUrl: config.DATAVERSE_DISCOVERY_URL,
      powerPlatformEnrichment: config.POWER_PLATFORM_ENRICHMENT,
    },
    safety: {
      businessLogicBypassAllowed: config.ALLOW_BUSINESS_LOGIC_BYPASS,
      canBypass: s.planning.bypassAllowed(req.ctx),
    },
    database: s.db ? (config.DATABASE_URL ? 'postgres' : 'pglite') : 'unknown',
  }));

  app.post('/api/demo/reset', async (req) => {
    if (!config.DEMO_MODE || !req.ctx.isDemoOrg) throw forbidden('Demo data can only be reset in DEMO MODE');
    if (req.ctx.role !== 'ADMIN') throw forbidden('Only administrators can reset demo data');
    await seedDemoData(s.db, { reset: true });
    const envs = await s.environments.list(req.ctx);
    for (const e of envs) s.metadata.invalidateCounts(e.id);
    await s.audit.record({ organizationId: req.ctx.organizationId, userId: req.ctx.userId, action: 'DEMO_DATA_RESET', outcome: 'SUCCESS', requestId: req.id });
    return { ok: true };
  });
}

function toApiError(err: unknown, action: string) {
  return err instanceof AppError ? err : new AppError(502, 'DATAVERSE_ERROR', `${action} failed: ${(err as Error).message}`);
}
