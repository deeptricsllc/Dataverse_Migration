import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PROJECT_KINDS, SCHEDULE_MODES, STAGED_SOURCE_KINDS } from '../../../shared/domain';
import { csvFileName, toCsv } from '../lib/csv';
import type { Services } from '../services/container';

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const tableName = z.string().regex(/^[A-Za-z0-9_.]{1,257}$/);

/**
 * Big enough for a mapping workbook or a source extract, small enough that nothing else fits.
 * Base64 inflates by a third, so the body limit is above the 32 MB file limit the importer enforces.
 */
const UPLOAD_BODY_LIMIT = 48 * 1024 * 1024;

/**
 * Projects, source analysis, mapping workbooks and schedules.
 *
 * A separate module from the original routes because these are a distinct half of the product: the
 * part that reads a system to understand it, and the part that keeps a migration running over time.
 */
export async function registerProjectRoutes(app: FastifyInstance, s: Services) {
  const sendCsv = (
    reply: FastifyReply,
    name: string,
    headers: string[],
    rows: (string | number | null)[][],
  ) =>
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(toCsv(headers, rows));

  const sendWorkbook = (reply: FastifyReply, file: { filename: string; buffer: Buffer }) =>
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${file.filename}"`)
      .send(file.buffer);

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  app.get('/api/projects', async (req) => {
    const q = z
      .object({
        kind: z.enum(PROJECT_KINDS).optional(),
        includeArchived: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    return s.projects.list(req.ctx, q);
  });

  app.post('/api/projects', async (req) => {
    const body = z
      .object({
        name: z.string().min(1).max(200),
        kind: z.enum(PROJECT_KINDS),
        description: z.string().max(2000).nullish(),
        sourceEnvironmentId: uuid.nullish(),
        targetEnvironmentId: uuid.nullish(),
        analysisProjectId: uuid.nullish(),
      })
      .parse(req.body);
    return s.projects.create(req.ctx, body);
  });

  app.get('/api/projects/:id', async (req) => s.projects.get(req.ctx, idParams.parse(req.params).id));

  app.patch('/api/projects/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullish(),
        sourceEnvironmentId: uuid.nullish(),
        targetEnvironmentId: uuid.nullish(),
        analysisProjectId: uuid.nullish(),
        status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
      })
      .parse(req.body ?? {});
    return s.projects.update(req.ctx, id, body);
  });

  app.post('/api/projects/:id/archive', async (req) =>
    s.projects.archive(req.ctx, idParams.parse(req.params).id),
  );

  /** The plans inside a migration project. */
  app.get('/api/projects/:id/plans', async (req) =>
    s.planning.listForProject(req.ctx, idParams.parse(req.params).id),
  );

  // ---------------------------------------------------------------------------
  // Source analysis
  // ---------------------------------------------------------------------------

  /** The tables this project's source offers, so an analysis can be scoped before it runs. */
  app.get('/api/projects/:id/source-tables', async (req) =>
    s.analysis.availableTables(req.ctx, idParams.parse(req.params).id),
  );

  app.get('/api/projects/:id/analyses', async (req) =>
    s.analysis.list(req.ctx, idParams.parse(req.params).id),
  );

  app.post('/api/projects/:id/analyses', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = z
      .object({
        name: z.string().max(200).optional(),
        tables: z.array(tableName).max(200).optional(),
        sampleSize: z.coerce.number().int().min(100).max(200_000).optional(),
        full: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    return s.analysis.create(req.ctx, id, body);
  });

  app.get('/api/analyses/:id', async (req) => s.analysis.get(req.ctx, idParams.parse(req.params).id));

  app.get('/api/analyses/:id/tables/:table', async (req) => {
    const { id, table } = z.object({ id: uuid, table: tableName }).parse(req.params);
    return s.analysis.table(req.ctx, id, table);
  });

  app.get('/api/analyses/:id/findings', async (req) => {
    const { id } = idParams.parse(req.params);
    const q = z
      .object({ severity: z.enum(['BLOCKER', 'WARNING']).optional(), table: tableName.optional() })
      .parse(req.query);
    return s.analysis.findings(req.ctx, id, q);
  });

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  app.get('/api/analyses/:id/tables.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const run = await s.analysis.get(req.ctx, id);
    return sendCsv(
      reply,
      csvFileName(['analysis-tables', run.name]),
      [
        'Table',
        'Display name',
        'Records',
        'Estimated',
        'Columns',
        'Examined',
        'Statistics',
        'Blockers',
        'Warnings',
        'Load order',
        'Depends on',
        'Empty columns',
      ],
      run.tables.map((t) => [
        t.logicalName,
        t.displayName,
        t.recordCount,
        t.recordCountApproximate ? 'yes' : 'no',
        t.columnCount,
        t.examined,
        t.basis,
        t.blockers,
        t.warnings,
        t.orderIndex + 1,
        t.dependsOn.join(' '),
        t.emptyColumns.join(' '),
      ]),
    );
  });

  app.get('/api/analyses/:id/findings.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const q = z
      .object({ severity: z.enum(['BLOCKER', 'WARNING']).optional(), table: tableName.optional() })
      .parse(req.query);
    const [run, findings] = await Promise.all([
      s.analysis.get(req.ctx, id),
      s.analysis.findings(req.ctx, id, q),
    ]);
    return sendCsv(
      reply,
      csvFileName(['analysis-findings', run.name]),
      ['Table', 'Field', 'Severity', 'Code', 'Finding', 'Affected', 'Statistics', 'Suggested resolution'],
      findings.map((f) => [
        f.table,
        f.field,
        f.severity,
        f.code,
        f.message,
        f.affected,
        f.basis,
        f.resolution,
      ]),
    );
  });

  /** Every profiled column of an analysis, one row each. The wide view people take away. */
  app.get('/api/analyses/:id/columns.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const run = await s.analysis.get(req.ctx, id);
    const rows: (string | number | null)[][] = [];
    for (const table of run.tables) {
      const detail = await s.analysis.table(req.ctx, id, table.logicalName);
      for (const f of detail.profile.fields) {
        rows.push([
          table.logicalName,
          f.field,
          f.displayName,
          f.type,
          f.examined,
          f.nullCount,
          f.blankCount,
          f.distinctCount,
          f.duplicateCount,
          f.minLength,
          f.maxLength,
          f.minValue,
          f.maxValue,
          f.minDate,
          f.maxDate,
          f.basis,
          f.issues.length,
        ]);
      }
    }
    return sendCsv(
      reply,
      csvFileName(['analysis-columns', run.name]),
      [
        'Table',
        'Field',
        'Display name',
        'Type',
        'Examined',
        'Nulls',
        'Blanks',
        'Distinct',
        'Duplicates',
        'Min length',
        'Max length',
        'Min value',
        'Max value',
        'Earliest date',
        'Latest date',
        'Statistics',
        'Findings',
      ],
      rows,
    );
  });

  // ---------------------------------------------------------------------------
  // Mapping workbook
  // ---------------------------------------------------------------------------

  app.get('/api/analyses/:id/mapping.xlsx', async (req, reply) =>
    sendWorkbook(reply, await s.mappingWorkbooks.forAnalysis(req.ctx, idParams.parse(req.params).id)),
  );

  app.get('/api/plans/:id/mapping.xlsx', async (req, reply) =>
    sendWorkbook(reply, await s.mappingWorkbooks.forPlan(req.ctx, idParams.parse(req.params).id)),
  );

  /**
   * A returned workbook. Dry run unless `apply` is true, so what a sheet contains is seen before it
   * takes effect. The file arrives base64-encoded in JSON: a mapping sheet is small, and this keeps
   * the upload inside the same CSRF-protected JSON path as every other write.
   */
  app.post('/api/plans/:id/mapping-workbook', { bodyLimit: UPLOAD_BODY_LIMIT }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = z
      .object({
        filename: z.string().max(300).optional(),
        contentBase64: z.string().min(1),
        apply: z.boolean().default(false),
      })
      .parse(req.body);
    const content = Buffer.from(body.contentBase64, 'base64');
    return s.mappingWorkbooks.importIntoPlan(
      req.ctx,
      id,
      { content, filename: body.filename },
      { apply: body.apply },
    );
  });

  // ---------------------------------------------------------------------------
  // Staged sources: files, and anything else read once and kept
  // ---------------------------------------------------------------------------

  /** Creates a source that holds imported data. No host, port or credential is involved. */
  app.post('/api/staged-sources', async (req, reply) => {
    const body = z
      .object({
        displayName: z.string().min(1).max(200),
        kind: z.enum(STAGED_SOURCE_KINDS).default('UPLOAD'),
      })
      .parse(req.body);
    reply.code(201);
    return s.stagedSources.create(req.ctx, body);
  });

  app.get('/api/staged-sources/:id/tables', async (req) =>
    s.stagedSources.list(req.ctx, idParams.parse(req.params).id),
  );

  /**
   * Imports a CSV or workbook. The file arrives base64-encoded in JSON, which keeps the upload on
   * the same CSRF-protected path as every other write and needs no multipart parser.
   */
  app.post('/api/staged-sources/:id/import', { bodyLimit: UPLOAD_BODY_LIMIT }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = z
      .object({
        filename: z.string().min(1).max(300),
        contentBase64: z.string().min(1),
      })
      .parse(req.body);
    return s.stagedSources.importFile(req.ctx, id, {
      filename: body.filename,
      content: Buffer.from(body.contentBase64, 'base64'),
    });
  });

  /** Imports a spreadsheet out of OneDrive or a SharePoint document library. */
  app.post('/api/staged-sources/:id/import-onedrive', async (req) => {
    const { id } = idParams.parse(req.params);
    const { reference } = z.object({ reference: z.string().min(1).max(2000) }).parse(req.body);
    return s.stagedSources.importFromGraph(req.ctx, id, { reference });
  });

  /** Imports a SharePoint list, given as sites/{site-id}/lists/{list-id}. */
  app.post('/api/staged-sources/:id/import-sharepoint-list', async (req) => {
    const { id } = idParams.parse(req.params);
    const { reference } = z.object({ reference: z.string().min(1).max(2000) }).parse(req.body);
    return s.stagedSources.importFromSharePointList(req.ctx, id, { reference });
  });

  app.delete('/api/staged-sources/:id/tables/:table', async (req, reply) => {
    const { id, table } = z.object({ id: uuid, table: tableName }).parse(req.params);
    await s.stagedSources.removeTable(req.ctx, id, table);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------
  // Schedules
  // ---------------------------------------------------------------------------

  app.get('/api/plans/:id/schedules', async (req) =>
    s.schedules.listForPlan(req.ctx, idParams.parse(req.params).id),
  );

  app.post('/api/plans/:id/schedules', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = z
      .object({
        name: z.string().max(200).optional(),
        cron: z.string().min(1).max(120),
        timeZone: z.string().max(80).optional(),
        mode: z.enum(SCHEDULE_MODES).optional(),
        watermarkField: z
          .string()
          .regex(/^[A-Za-z0-9_ #$@.]{1,128}$/)
          .nullish(),
        enabled: z.boolean().optional(),
        confirmSourceName: z.string().min(1).max(300),
        confirmTargetName: z.string().min(1).max(300),
      })
      .parse(req.body);
    return s.schedules.create(req.ctx, id, body);
  });

  app.get('/api/schedules/:id', async (req) => s.schedules.get(req.ctx, idParams.parse(req.params).id));

  app.patch('/api/schedules/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = z
      .object({
        name: z.string().max(200).optional(),
        cron: z.string().min(1).max(120).optional(),
        timeZone: z.string().max(80).optional(),
        enabled: z.boolean().optional(),
        mode: z.enum(SCHEDULE_MODES).optional(),
        watermarkField: z
          .string()
          .regex(/^[A-Za-z0-9_ #$@.]{1,128}$/)
          .nullish(),
        /** Re-confirms the warnings the plan has now, so a paused schedule may fire again. */
        acknowledgeWarnings: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    return s.schedules.update(req.ctx, id, body);
  });

  app.delete('/api/schedules/:id', async (req, reply) => {
    await s.schedules.remove(req.ctx, idParams.parse(req.params).id);
    return reply.code(204).send();
  });

  /** Fire now, without disturbing the recurrence. */
  app.post('/api/schedules/:id/trigger', async (req) =>
    s.schedules.trigger(req.ctx, idParams.parse(req.params).id),
  );

  app.get('/api/schedules/:id/history', async (req) => {
    const { id } = idParams.parse(req.params);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .parse(req.query);
    return s.schedules.history(req.ctx, id, limit);
  });
}
