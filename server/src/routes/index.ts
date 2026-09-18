import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CONDITION_OPERATORS, TRANSFORMATION_KINDS } from '../../../shared/domain';
import { SESSION_COOKIE, safeReturnTo } from '../auth/auth-service';
import { seedDemoData } from '../dataverse/factory';
import { csvFileName, toCsv, type CsvValue } from '../lib/csv';
import { AppError, forbidden } from '../lib/errors';
import type { Services } from '../services/container';

const uuid = z.string().uuid();
/** Dataverse logical name (`account`) or schema-qualified SQL table (`dbo.Customer`). */
const tableName = z.string().regex(/^[A-Za-z0-9_.]{1,257}$/);
/** A SQL column or Dataverse attribute name. */
const fieldName = z.string().regex(/^[A-Za-z0-9_ #$@]{1,128}$/);
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

  app.get('/api/auth/config', async () => ({
    microsoftEnabled: config.microsoftEnabled,
    demoEnabled: config.DEMO_MODE,
    realTenantReadOnly: config.REAL_TENANT_READ_ONLY,
  }));

  app.get('/api/auth/session', async (req) => {
    const readOnly = config.REAL_TENANT_READ_ONLY;
    if (!req.session) return { user: null, csrfToken: null, realTenantReadOnly: readOnly };
    return { user: req.session.user, csrfToken: req.session.csrfToken, realTenantReadOnly: readOnly };
  });

  app.get(
    '/api/auth/login',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!config.microsoftEnabled)
        throw new AppError(404, 'MICROSOFT_NOT_CONFIGURED', 'Microsoft sign-in is not configured');
      const { returnTo } = z.object({ returnTo: z.string().max(500).optional() }).parse(req.query);
      const url = await s.auth.beginMicrosoftSignIn(safeReturnTo(returnTo));
      return reply.redirect(url);
    },
  );

  app.get(
    '/api/auth/callback',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const q = z
        .object({
          code: z.string().max(4000).optional(),
          state: z.string().max(200).optional(),
          error: z.string().max(200).optional(),
          error_description: z.string().max(2000).optional(),
        })
        .parse(req.query);
      if (q.error || !q.code || !q.state) {
        req.log.warn({ error: q.error }, 'Microsoft sign-in returned an error');
        const reason = encodeURIComponent(
          q.error === 'access_denied'
            ? 'Consent was declined or access was denied.'
            : 'Microsoft sign-in did not complete.',
        );
        return reply.redirect(`/login?error=${reason}`);
      }
      try {
        const { userId, returnTo } = await s.auth.completeMicrosoftSignIn(
          { code: q.code, state: q.state },
          req.id,
        );
        const session = await s.auth.createSession(userId, req.headers['user-agent']);
        reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
        return reply.redirect(returnTo);
      } catch (err) {
        const message = err instanceof AppError ? err.message : 'Microsoft sign-in failed.';
        if (!(err instanceof AppError)) req.log.error({ err }, 'Microsoft sign-in failed');
        return reply.redirect(`/login?error=${encodeURIComponent(message)}`);
      }
    },
  );

  app.post(
    '/api/auth/demo-login',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const userId = await s.auth.demoSignIn(req.id);
      const session = await s.auth.createSession(userId, req.headers['user-agent']);
      reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
      const resolved = await s.auth.resolveSession(session.token);
      return { user: resolved!.user, csrfToken: resolved!.csrfToken };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const provider = req.session!.user.authProvider;
    await s.audit.record({
      organizationId: req.ctx.organizationId,
      userId: req.ctx.userId,
      action: 'AUTH_SIGN_OUT',
      outcome: 'SUCCESS',
      requestId: req.id,
    });
    await s.auth.destroySession(req.session!.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { logoutUrl: provider === 'microsoft' && config.microsoftEnabled ? s.identity.logoutUrl() : null };
  });

  // ---------------------------------------------------------------------------
  // Environments & metadata
  // ---------------------------------------------------------------------------

  app.get('/api/environments', async (req) => s.environments.list(req.ctx));
  app.post('/api/environments/discover', async (req) => s.environments.discover(req.ctx));
  app.post('/api/environments/:id/test', async (req) =>
    s.environments.testConnection(req.ctx, idParams.parse(req.params).id),
  );

  app.get('/api/workspace', async (req) => s.environments.getWorkspace(req.ctx));
  app.put('/api/workspace', async (req) => {
    const body = z
      .object({ sourceEnvironmentId: uuid.nullable(), targetEnvironmentId: uuid.nullable() })
      .parse(req.body);
    return s.environments.setWorkspace(req.ctx, body);
  });

  app.get('/api/environments/:id/tables', async (req) => {
    const { id } = idParams.parse(req.params);
    const { refresh } = z.object({ refresh: z.enum(['true', 'false']).optional() }).parse(req.query);
    const env = await s.environments.getAccessible(req.ctx, id);
    const conn = await s.connections.connectorFor(env, req.ctx.userId, { requestId: req.id });
    return s.metadata.getCatalog(env.id, conn, refresh === 'true').catch((err) => {
      throw toApiError(err, 'Table discovery');
    });
  });

  app.get('/api/environments/:id/tables/:table', async (req) => {
    const { id, table } = z.object({ id: uuid, table: tableName }).parse(req.params);
    const { refresh } = z.object({ refresh: z.enum(['true', 'false']).optional() }).parse(req.query);
    const env = await s.environments.getAccessible(req.ctx, id);
    const conn = await s.connections.connectorFor(env, req.ctx.userId, { requestId: req.id });
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
    const q = z
      .object({ sourceEnvironmentId: uuid.optional(), targetEnvironmentId: uuid.optional() })
      .parse(req.query);
    return s.comparisons.list(req.ctx, q);
  });
  app.get('/api/comparisons/:id', async (req) => s.comparisons.get(req.ctx, idParams.parse(req.params).id));
  app.get('/api/comparisons/:id/tables', async (req) =>
    s.comparisons.tables(req.ctx, idParams.parse(req.params).id),
  );

  // ---------------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------------

  app.get('/api/migration/candidates', async (req) => {
    const q = z.object({ sourceEnvironmentId: uuid, targetEnvironmentId: uuid }).parse(req.query);
    return s.planning.candidates(req.ctx, q.sourceEnvironmentId, q.targetEnvironmentId);
  });

  app.put('/api/table-categories/:table', async (req) => {
    const { table } = z.object({ table: tableName }).parse(req.params);
    const { category } = z
      .object({ category: z.enum(['CONFIGURATION', 'REFERENCE', 'TRANSACTIONAL']).nullable() })
      .parse(req.body);
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
  app.post('/api/plans/:id/revalidate', async (req) =>
    s.planning.revalidate(req.ctx, idParams.parse(req.params).id),
  );
  app.patch('/api/plans/:id/options', async (req) => {
    const patch = z
      .object({
        conflictStrategy: z.enum(['SKIP_EXISTING', 'CREATE_ONLY', 'UPSERT', 'SYNC']).optional(),
        batchSize: z.number().int().min(1).max(500).optional(),
        maxRetries: z.number().int().min(0).max(10).optional(),
        bypassCustomBusinessLogic: z.boolean().optional(),
        suppressFlowTriggers: z.boolean().optional(),
        stopOnFirstError: z.boolean().optional(),
        auditPolicy: z.enum(['NONE', 'STANDARD', 'PRESERVE_ATTRIBUTION']).optional(),
        userResolutionPolicy: z.enum(['STRICT', 'FALLBACK']).optional(),
        fallbackPrincipal: z
          .object({
            logicalName: z.enum(['systemuser', 'team', 'businessunit']),
            id: z.string().max(80),
            name: z.string().max(200),
          })
          .nullable()
          .optional(),
      })
      .strict()
      .parse(req.body);
    return s.planning.updateOptions(req.ctx, idParams.parse(req.params).id, patch);
  });
  app.patch('/api/plans/:id/entities/:entityId', async (req) => {
    const { id, entityId } = z.object({ id: uuid, entityId: uuid }).parse(req.params);
    const body = z
      .object({
        matchStrategy: z.enum(['PRIMARY_ID', 'ALTERNATE_KEY', 'BUSINESS_KEY']),
        alternateKey: z.string().max(200).nullable(),
        businessKeyFields: z.array(tableName).max(10).optional(),
      })
      .parse(req.body);
    return s.planning.updateEntity(req.ctx, id, entityId, body);
  });
  /** Pairs a source table with the target table it migrates into. */
  app.patch('/api/plans/:id/entities/:entityId/object-mapping', async (req) => {
    const { id, entityId } = z.object({ id: uuid, entityId: uuid }).parse(req.params);
    const body = z
      .object({
        targetLogicalName: tableName.nullable(),
        status: z.enum(['CONFIRMED', 'MANUAL', 'UNMAPPED', 'IGNORED']),
      })
      .parse(req.body);
    return s.planning.updateObjectMapping(req.ctx, id, entityId, body);
  });

  app.get('/api/plans/:id/entities/:entityId/target-candidates', async (req) => {
    const { id, entityId } = z.object({ id: uuid, entityId: uuid }).parse(req.params);
    return s.planning.targetCandidates(req.ctx, id, entityId);
  });

  /** The distinct source values of a column, so a choice mapping can be built from real data. */
  app.get('/api/plans/:id/entities/:entityId/values/:field', async (req) => {
    const { id, entityId, field } = z
      .object({ id: uuid, entityId: uuid, field: fieldName })
      .parse(req.params);
    return s.planning.sourceValues(req.ctx, id, entityId, field);
  });

  app.patch('/api/plans/:id/mappings/:mappingId/choice-map', async (req) => {
    const { id, mappingId } = z.object({ id: uuid, mappingId: uuid }).parse(req.params);
    const body = z
      .object({
        entries: z
          .array(
            z.object({
              sourceValue: z.string().max(400),
              targetValue: z.number().int().nullable(),
              targetLabel: z.string().max(200).nullable(),
              status: z.enum(['AUTO_SUGGESTED', 'CONFIRMED', 'UNMAPPED', 'IGNORED']),
            }),
          )
          .max(500),
        defaultTargetValue: z.number().int().nullable(),
      })
      .parse(req.body);
    return s.planning.updateChoiceMap(req.ctx, id, mappingId, body);
  });

  app.patch('/api/plans/:id/mappings/:mappingId/transform', async (req) => {
    const { id, mappingId } = z.object({ id: uuid, mappingId: uuid }).parse(req.params);
    const body = z
      .object({
        kind: z.enum(['DIRECT', 'TRIM', 'UPPER', 'LOWER', 'CONSTANT', 'DEFAULT_IF_NULL', 'CHOICE_MAP']),
        value: z.union([z.string().max(400), z.number(), z.boolean(), z.null()]).optional(),
      })
      .parse(req.body);
    return s.planning.updateTransform(req.ctx, id, mappingId, body);
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
      .object({
        confirmSourceName: z.string().max(300),
        confirmTargetName: z.string().max(300),
        acknowledgeWarnings: z.boolean(),
      })
      .parse(req.body);
    return s.runs.start(req.ctx, idParams.parse(req.params).id, body);
  });

  // ---------------------------------------------------------------------------
  // Connections (SQL Server / Azure SQL). Dataverse environments come from discovery.
  // ---------------------------------------------------------------------------

  const sqlConnectionBody = z.object({
    displayName: z.string().min(1).max(200),
    connectionType: z.enum(['SQL_SERVER', 'AZURE_SQL']),
    host: z.string().min(1).max(255),
    port: z.coerce.number().int().min(1).max(65535).default(1433),
    database: z.string().min(1).max(128),
    authType: z
      .enum(['SQL_LOGIN', 'ENTRA_PASSWORD', 'ENTRA_INTEGRATED', 'MANAGED_IDENTITY', 'WINDOWS'])
      .default('SQL_LOGIN'),
    username: z.string().max(128).nullable().default(null),
    // Write-only: a password is accepted, never returned.
    password: z.string().max(400).nullable().optional(),
    encrypt: z.boolean().default(true),
    trustServerCertificate: z.boolean().default(false),
    schemas: z.array(z.string().max(128)).max(50).default([]),
    transport: z.enum(['DIRECT', 'AGENT']).default('DIRECT'),
  });

  app.post('/api/connections', async (req, reply) => {
    const body = sqlConnectionBody.parse(req.body);
    reply.code(201);
    return s.connectionAdmin.create(req.ctx, body);
  });

  app.patch('/api/connections/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    return s.connectionAdmin.update(req.ctx, id, sqlConnectionBody.parse(req.body));
  });

  /** Tests settings that have not been saved yet, so nothing is stored until they work. */
  app.post('/api/connections/test', async (req) =>
    s.connectionAdmin.testUnsaved(req.ctx, sqlConnectionBody.parse(req.body)),
  );

  app.post('/api/connections/:id/test', async (req) =>
    s.connectionAdmin.test(req.ctx, idParams.parse(req.params).id),
  );

  app.delete('/api/connections/:id', async (req) =>
    s.connectionAdmin.remove(req.ctx, idParams.parse(req.params).id),
  );

  // ---------------------------------------------------------------------------
  // Profiling, data quality and transformations
  // ---------------------------------------------------------------------------

  /**
   * A transformation rule, validated server-side. The `kind` is a closed enum, so configuration
   * can never smuggle in code: there is no expression, script or SQL anywhere in this shape.
   */
  const conditionSchema = z.object({
    field: fieldName.nullish(),
    operator: z.enum(CONDITION_OPERATORS),
    value: z.union([z.string().max(400), z.number(), z.boolean(), z.null()]).optional(),
  });
  const baseRule = {
    kind: z.enum(TRANSFORMATION_KINDS),
    find: z.string().max(200).nullish(),
    replaceWith: z.string().max(200).nullish(),
    value: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]).optional(),
    start: z.number().int().min(0).max(10_000).nullish(),
    length: z.number().int().min(0).max(1_000_000).nullish(),
    inputFormat: z.string().max(20).nullish(),
    assumeUtc: z.boolean().nullish(),
    scale: z.number().int().min(0).max(10).nullish(),
    map: z
      .array(
        z.object({
          from: z.string().max(400),
          to: z.union([z.string().max(400), z.number(), z.boolean(), z.null()]),
        }),
      )
      .max(500)
      .optional(),
    onUnmapped: z.enum(['BLOCK', 'IGNORE', 'DEFAULT']).optional(),
    defaultValue: z.union([z.string().max(400), z.number(), z.boolean(), z.null()]).optional(),
    parts: z
      .array(z.object({ field: fieldName.nullish(), literal: z.string().max(200).nullish() }))
      .max(20)
      .optional(),
    separator: z.string().max(20).nullish(),
    skipEmptyParts: z.boolean().nullish(),
    condition: conditionSchema.nullish(),
    action: z.enum(['SET_VALUE', 'SET_NULL', 'APPLY']).nullish(),
  };
  // One level of nesting only: a conditional may apply rules, but those rules may not nest again.
  const transformationRule = z.object({ ...baseRule, then: z.array(z.object(baseRule)).max(10).optional() });
  const transformationRules = z.array(transformationRule).max(20);

  app.get('/api/transformation-templates', async () => s.transformations.templates());

  /** Profiles a source table for a plan, using the rules its target schema implies. */
  app.post('/api/plans/:id/entities/:entityId/profile', async (req) => {
    const { id, entityId } = z.object({ id: uuid, entityId: uuid }).parse(req.params);
    const body = z
      .object({ sampleSize: z.number().int().min(1).max(200_000).optional(), full: z.boolean().optional() })
      .parse(req.body ?? {});
    return s.dataQuality.profileEntity(req.ctx, id, entityId, body);
  });

  app.get('/api/plans/:id/entities/:entityId/quality-rules', async (req) => {
    const { id, entityId } = z.object({ id: uuid, entityId: uuid }).parse(req.params);
    return s.dataQuality.rulesForEntity(req.ctx, id, entityId);
  });

  /** The workspace data-quality summary: every mapped table profiled and grouped by category. */
  app.post('/api/plans/:id/data-quality', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = z
      .object({ sampleSize: z.number().int().min(1).max(200_000).optional() })
      .parse(req.body ?? {});
    const { profiles: _profiles, ...summary } = await s.dataQuality.summary(req.ctx, id, body);
    return summary;
  });

  /** Profiles any table of any connection, independently of a plan. */
  app.post('/api/environments/:id/tables/:table/profile', async (req) => {
    const { id, table } = z.object({ id: uuid, table: tableName }).parse(req.params);
    const body = z
      .object({
        fields: z.array(fieldName).max(300).optional(),
        sampleSize: z.number().int().min(1).max(200_000).optional(),
        full: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    return s.profiling.profileTable(req.ctx, { environmentId: id, table, ...body });
  });

  app.get('/api/environments/:id/tables/:table/fields/:field/profile', async (req) => {
    const { id, table, field } = z.object({ id: uuid, table: tableName, field: fieldName }).parse(req.params);
    const { sampleSize } = z
      .object({ sampleSize: z.coerce.number().int().min(1).max(200_000).optional() })
      .parse(req.query);
    return s.profiling.profileField(req.ctx, { environmentId: id, table, field, sampleSize });
  });

  /** Replaces the ordered transformation pipeline of one field mapping. */
  app.patch('/api/plans/:id/mappings/:mappingId/transformations', async (req) => {
    const { id, mappingId } = z.object({ id: uuid, mappingId: uuid }).parse(req.params);
    const { rules } = z.object({ rules: transformationRules }).parse(req.body);
    return s.transformations.updatePipeline(req.ctx, id, mappingId, rules);
  });

  /**
   * Previews a candidate pipeline over real source values, using the same engine the migration
   * uses. Nothing is saved, so a user can see what a rule does before committing to it.
   */
  app.post('/api/plans/:id/mappings/:mappingId/preview', async (req) => {
    const { id, mappingId } = z.object({ id: uuid, mappingId: uuid }).parse(req.params);
    const { rules } = z.object({ rules: transformationRules.nullish() }).parse(req.body ?? {});
    return s.transformations.previewField(req.ctx, id, mappingId, rules ?? null);
  });

  /** Record-level before/after: source value, transformed value, and what the target holds. */
  app.get('/api/plans/:id/entities/:entityId/preview', async (req) => {
    const { id, entityId } = z.object({ id: uuid, entityId: uuid }).parse(req.params);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(50).default(10) })
      .parse(req.query);
    return s.transformations.previewRecords(req.ctx, id, entityId, limit);
  });

  /** The transformations that will discard information, and whether they were accepted. */
  app.get('/api/plans/:id/lossy-transformations', async (req) =>
    s.transformations.lossyTransformations(req.ctx, idParams.parse(req.params).id),
  );

  app.post('/api/plans/:id/lossy-transformations/acknowledge', async (req) => {
    const { id } = idParams.parse(req.params);
    const { accepted } = z.object({ accepted: z.array(z.string().max(300)).max(500) }).parse(req.body);
    return s.planning.acknowledgeLossy(req.ctx, id, accepted);
  });

  // ---------------------------------------------------------------------------
  // Preflight (dry run) — reads only, never writes to Dataverse
  // ---------------------------------------------------------------------------

  app.post('/api/plans/:id/preflight', async (req) =>
    s.preflight.create(req.ctx, idParams.parse(req.params).id),
  );

  // Returns null (not 404) when no preflight has been run, so the UI can ask without an error.
  app.get('/api/plans/:id/preflight', async (req) =>
    s.preflight.latestForPlan(req.ctx, idParams.parse(req.params).id),
  );

  app.get('/api/preflight/:id', async (req) => s.preflight.get(req.ctx, idParams.parse(req.params).id));

  app.get('/api/preflight/:id/records', async (req) => {
    const { id } = idParams.parse(req.params);
    const q = page
      .extend({
        action: z.enum(['CREATE', 'UPDATE', 'UNCHANGED', 'CONFLICT', 'BLOCKED']).optional(),
        entity: tableName.optional(),
      })
      .parse(req.query);
    return s.preflight.records(req.ctx, id, q);
  });

  // ---------------------------------------------------------------------------
  // Diagnostics — read-only checks against the configured environments
  // ---------------------------------------------------------------------------

  app.post('/api/diagnostics', async (req) => {
    const body = z
      .object({ sourceEnvironmentId: uuid.optional(), targetEnvironmentId: uuid.optional() })
      .parse(req.body ?? {});
    return s.diagnostics.run(req.ctx, { ...body, authProvider: req.session!.user.authProvider });
  });

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  app.get('/api/runs', async (req) => s.runs.list(req.ctx));
  app.get('/api/runs/:id', async (req) => s.runs.get(req.ctx, idParams.parse(req.params).id));
  app.post('/api/runs/:id/:action', async (req) => {
    const { id, action } = z
      .object({ id: uuid, action: z.enum(['cancel', 'pause', 'resume', 'retry']) })
      .parse(req.params);
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
    const q = page
      .extend({
        entity: tableName.optional(),
        outcome: z.enum(['CREATED', 'UPDATED', 'UNCHANGED', 'SKIPPED', 'FAILED']).optional(),
      })
      .parse(req.query);
    return s.runs.records(req.ctx, id, q);
  });
  // --- CSV exports -----------------------------------------------------------
  // Everything a team needs to review or fix issues outside the application.
  const sendCsv = (reply: FastifyReply, name: string, headers: string[], rows: CsvValue[][]) =>
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(toCsv(headers, rows));

  app.get('/api/runs/:id/errors.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const q = z
      .object({
        entity: tableName.optional(),
        kind: z.enum(['all', 'retryable', 'permanent']).optional(),
        severity: z.enum(['ERROR', 'WARNING']).optional(),
        includeResolved: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query);
    const run = await s.runs.get(req.ctx, id);
    const { items } = await s.runs.errors(req.ctx, id, {
      ...q,
      includeResolved: q.includeResolved === 'true',
      limit: 50_000,
      offset: 0,
    });
    return sendCsv(
      reply,
      csvFileName(['migration-errors', run.planName]),
      [
        'Table',
        'Source record id',
        'Operation',
        'Field',
        'Severity',
        'Error code',
        'Message',
        'Retryable',
        'Attempts',
        'Resolved',
        'Occurred at',
      ],
      items.map((e) => [
        e.entity,
        e.sourceRecordId,
        e.operation,
        e.field,
        e.severity,
        e.errorCode,
        e.message,
        e.retryable,
        e.attempts,
        e.resolved,
        e.createdAt,
      ]),
    );
  });

  app.get('/api/runs/:id/records.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const q = z
      .object({
        entity: tableName.optional(),
        outcome: z.enum(['CREATED', 'UPDATED', 'UNCHANGED', 'SKIPPED', 'FAILED']).optional(),
      })
      .parse(req.query);
    const run = await s.runs.get(req.ctx, id);
    const { items } = await s.runs.records(req.ctx, id, { ...q, limit: 100_000, offset: 0 });
    return sendCsv(
      reply,
      csvFileName(['migration-records', run.planName]),
      ['Table', 'Source id', 'Target id', 'Outcome', 'Matched by', 'Deferred lookups', 'Updated at'],
      items.map((m) => [
        m.entity,
        m.sourceId,
        m.targetId,
        m.outcome,
        m.matchMethod,
        m.deferredStatus,
        m.updatedAt,
      ]),
    );
  });

  app.get('/api/validations/:id/differences.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const q = z
      .object({
        entity: tableName.optional(),
        type: z
          .enum([
            'MISSING_IN_TARGET',
            'VALUE_MISMATCH',
            'LOOKUP_MISMATCH',
            'BROKEN_REFERENCE',
            'PRE_EXISTING_DIFFERENCE',
          ])
          .optional(),
        outcome: z.enum(['PASS', 'WARNING', 'FAIL']).optional(),
      })
      .parse(req.query);
    const run = await s.validation.get(req.ctx, id);
    const { items } = await s.validation.differences(req.ctx, id, { ...q, limit: 50_000, offset: 0 });
    return sendCsv(
      reply,
      csvFileName([
        'validation-differences',
        run.sourceEnvironment.displayName,
        run.targetEnvironment.displayName,
      ]),
      [
        'Table',
        'Source record id',
        'Target record id',
        'Field',
        'Source value',
        'Target value',
        'Difference',
        'Outcome',
      ],
      items.map((d) => [
        d.entity,
        d.sourceRecordId,
        d.targetRecordId,
        d.field,
        d.sourceValue,
        d.targetValue,
        d.differenceType,
        d.outcome,
      ]),
    );
  });

  app.get('/api/validations/:id/summary.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const run = await s.validation.get(req.ctx, id);
    return sendCsv(
      reply,
      csvFileName([
        'validation-summary',
        run.sourceEnvironment.displayName,
        run.targetEnvironment.displayName,
      ]),
      [
        'Table',
        'Outcome',
        'Source rows',
        'Target rows',
        'Migrated',
        'Checked',
        'Matched',
        'Missing',
        'Different',
        'Broken references',
        'Checks',
      ],
      run.entities.map((e) => [
        e.logicalName,
        e.outcome,
        e.sourceCount,
        e.targetCount,
        e.migratedRecords,
        e.checkedRecords,
        e.matched,
        e.missing,
        e.different,
        e.brokenReferences,
        e.checks.map((c) => `${c.check}: ${c.outcome} - ${c.message}`).join(' | '),
      ]),
    );
  });

  app.get('/api/comparisons/:id/tables.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const run = await s.comparisons.get(req.ctx, id);
    const tables = await s.comparisons.tables(req.ctx, id);
    const describe = (d: { property: string; source: unknown; target: unknown; note?: string }) =>
      `${d.property}: ${String(d.source)} -> ${String(d.target)}${d.note ? ` (${d.note})` : ''}`;
    const rows: CsvValue[][] = [];
    for (const t of tables) {
      rows.push([
        t.logicalName,
        t.displayName,
        t.status,
        '',
        '',
        '',
        '',
        t.differences.map(describe).join(' | '),
      ]);
      for (const c of t.columns.filter((x) => x.status !== 'MATCH')) {
        rows.push([
          t.logicalName,
          t.displayName,
          t.status,
          c.logicalName,
          c.status,
          c.sourceType,
          c.targetType,
          c.differences.map(describe).join(' | '),
        ]);
      }
    }
    return sendCsv(
      reply,
      csvFileName([
        'schema-comparison',
        run.sourceEnvironment.displayName,
        run.targetEnvironment.displayName,
      ]),
      [
        'Table',
        'Display name',
        'Table status',
        'Column',
        'Column status',
        'Source type',
        'Target type',
        'Differences',
      ],
      rows,
    );
  });

  app.get('/api/plans/:id/issues.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const plan = await s.planning.get(req.ctx, id);
    return sendCsv(
      reply,
      csvFileName(['plan-issues', plan.name]),
      ['Severity', 'Code', 'Table', 'Field', 'Message', 'Resolution'],
      plan.issues.map((i) => [i.severity, i.code, i.table, i.field, i.message, i.resolution]),
    );
  });

  app.get('/api/preflight/:id/records.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const q = z
      .object({
        action: z.enum(['CREATE', 'UPDATE', 'UNCHANGED', 'CONFLICT', 'BLOCKED']).optional(),
        entity: tableName.optional(),
      })
      .parse(req.query);
    const run = await s.preflight.get(req.ctx, id);
    const { items } = await s.preflight.records(req.ctx, id, { ...q, limit: 50_000, offset: 0 });
    return sendCsv(
      reply,
      csvFileName(['preflight', q.action ?? 'all', run.planName]),
      [
        'Table',
        'Source record id',
        'Record name',
        'Action',
        'Target record id',
        'Matched by',
        'Reason',
        'Field',
        'Source value',
        'Target value',
      ],
      items.flatMap((r) => {
        const head = [
          r.entity,
          r.sourceRecordId,
          r.recordName,
          r.action,
          r.targetRecordId,
          r.matchMethod,
          r.reason,
        ];
        const changes = r.changes.filter((c) => c.action !== 'UNCHANGED');
        return changes.length
          ? changes.map((c) => [...head, c.field, c.sourceValue, c.targetValue])
          : [[...head, null, null, null]];
      }),
    );
  });

  /** The data quality findings on their own, for the team fixing the source data. */
  app.get('/api/plans/:id/data-quality.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const [plan, rows] = await Promise.all([
      s.planning.get(req.ctx, id),
      s.dataQuality.issueRows(req.ctx, id),
    ]);
    return sendCsv(
      reply,
      csvFileName(['data-quality', plan.name]),
      [
        'Severity',
        'Category',
        'Source Connection',
        'Source Table',
        'Source Record ID',
        'Field',
        'Original Value',
        'Transformed Value',
        'Target Field',
        'Rule',
        'Issue',
        'Suggested Resolution',
      ],
      rows.map((r) => [
        r.severity,
        r.category,
        plan.sourceEnvironment.displayName,
        r.table,
        r.sourceRecordId,
        r.field,
        r.sourceValue,
        r.targetValue,
        null,
        r.category,
        r.issue,
        r.resolution ?? r.suggestedAction,
      ]),
    );
  });

  /** The remediation package: every issue a migration team must fix, in one file. */
  app.get('/api/plans/:id/issues-package.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const [plan, rows] = await Promise.all([
      s.planning.get(req.ctx, id),
      s.remediation.buildIssueRows(req.ctx, id),
    ]);
    return sendCsv(
      reply,
      csvFileName(['remediation-package', plan.name]),
      [
        'Severity',
        'Category',
        'Table',
        'Source Record ID',
        'Record Name',
        'Field',
        'Source Value',
        'Target Value',
        'Issue',
        'Resolution',
        'Suggested Action',
      ],
      rows.map((r) => [
        r.severity,
        r.category,
        r.table,
        r.sourceRecordId,
        r.recordName,
        r.field,
        r.sourceValue,
        r.targetValue,
        r.issue,
        r.resolution,
        r.suggestedAction,
      ]),
    );
  });

  app.get('/api/principal-mappings.csv', async (req, reply) => {
    const q = z.object({ sourceEnvironmentId: uuid, targetEnvironmentId: uuid }).parse(req.query);
    const summary = await s.principals.list(req.ctx, q.sourceEnvironmentId, q.targetEnvironmentId);
    return sendCsv(
      reply,
      csvFileName([
        'user-mapping',
        summary.sourceEnvironment.displayName,
        summary.targetEnvironment.displayName,
      ]),
      [
        'Type',
        'Source name',
        'Source login',
        'Source email',
        'Source id',
        'Target name',
        'Target id',
        'Status',
        'Matched by',
        'Confidence',
        'Note',
      ],
      summary.mappings.map((m) => [
        m.logicalName,
        m.source.name,
        m.source.login,
        m.source.email,
        m.source.id,
        m.target?.name,
        m.target?.id,
        m.status,
        m.matchMethod,
        m.confidence,
        m.note,
      ]),
    );
  });

  // --- Principal (user / team / business unit) mapping ------------------------

  app.get('/api/principal-mappings', async (req) => {
    const q = z.object({ sourceEnvironmentId: uuid, targetEnvironmentId: uuid }).parse(req.query);
    return s.principals.list(req.ctx, q.sourceEnvironmentId, q.targetEnvironmentId);
  });

  app.post('/api/principal-mappings/refresh', async (req) => {
    const body = z
      .object({
        sourceEnvironmentId: uuid,
        targetEnvironmentId: uuid,
        refreshDirectory: z.boolean().optional(),
      })
      .parse(req.body);
    return s.principals.refresh(req.ctx, body.sourceEnvironmentId, body.targetEnvironmentId, {
      refreshDirectory: body.refreshDirectory,
    });
  });

  app.put('/api/principal-mappings', async (req) => {
    const body = z
      .object({
        sourceEnvironmentId: uuid,
        targetEnvironmentId: uuid,
        logicalName: z.enum(['systemuser', 'team', 'businessunit']),
        sourceId: z.string().max(80),
        targetId: z.string().max(80).nullable(),
        ignore: z.boolean().optional(),
      })
      .parse(req.body);
    return s.principals.setMapping(req.ctx, body);
  });

  app.post('/api/principal-mappings/impersonation-check', async (req) => {
    const body = z.object({ sourceEnvironmentId: uuid, targetEnvironmentId: uuid }).parse(req.body);
    return s.principals.checkImpersonation(req.ctx, body.sourceEnvironmentId, body.targetEnvironmentId);
  });

  app.get('/api/runs/:id/rollback-preview', async (req) =>
    s.runs.rollbackPreview(req.ctx, idParams.parse(req.params).id),
  );

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
        type: z
          .enum([
            'MISSING_IN_TARGET',
            'VALUE_MISMATCH',
            'LOOKUP_MISMATCH',
            'BROKEN_REFERENCE',
            'PRE_EXISTING_DIFFERENCE',
          ])
          .optional(),
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
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
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
      realTenantReadOnly: config.REAL_TENANT_READ_ONLY,
    },
    database: s.db ? (config.DATABASE_URL ? 'postgres' : 'pglite') : 'unknown',
  }));

  app.post('/api/demo/reset', async (req) => {
    if (!config.DEMO_MODE || !req.ctx.isDemoOrg) throw forbidden('Demo data can only be reset in DEMO MODE');
    if (req.ctx.role !== 'ADMIN') throw forbidden('Only administrators can reset demo data');
    await seedDemoData(s.db, { reset: true });
    const envs = await s.environments.list(req.ctx);
    for (const e of envs) s.metadata.invalidateCounts(e.id);
    await s.audit.record({
      organizationId: req.ctx.organizationId,
      userId: req.ctx.userId,
      action: 'DEMO_DATA_RESET',
      outcome: 'SUCCESS',
      requestId: req.id,
    });
    return { ok: true };
  });
}

function toApiError(err: unknown, action: string) {
  return err instanceof AppError
    ? err
    : new AppError(502, 'DATAVERSE_ERROR', `${action} failed: ${(err as Error).message}`);
}
