import { asc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  MAPPING_SHEET_COLUMNS,
  TRANSFORMATION_KINDS,
  type AnalysisRunDto,
  type FieldProfileDto,
  type MappingImportChangeDto,
  type MappingImportPreviewDto,
  type TableProfileDto,
  type TransformationKind,
  type TransformationRule,
} from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { analysisTables, fieldMappings, migrationPlanEntities } from '../db/schema';
import { badRequest } from '../lib/errors';
import {
  readXlsx,
  rowsByHeader,
  writeXlsx,
  type XlsxReadSheet,
  type XlsxSheet,
  type XlsxValue,
} from '../lib/xlsx';
import {
  pipelineKey,
  readTransformationSheets,
  summarizeRules,
  transformationSheets,
  type FieldPipeline,
} from './transformation-sheets';
import type { AnalysisService } from './analysis-service';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import type { PlanningService } from './planning-service';
import type { TransformationService } from './transformation/transformation-service';
import type { ProjectService } from './project-service';

/** A returned workbook is small; anything this size is not a mapping sheet. */
const MAX_IMPORT_BYTES = 12 * 1024 * 1024;
const MAX_IMPORT_ROWS = 20_000;

/**
 * The mapping workbook: the document a migration is actually argued over.
 *
 * It leaves the tool, gets filled in by people who will never open the tool — the ones who know
 * what the legacy columns mean — and comes back. So it carries the source facts an analysis
 * established next to the empty target columns someone has to decide, and reading it back applies
 * those decisions through exactly the same validation the mapping screen uses. A workbook can never
 * set a mapping the UI would have refused.
 */
export class MappingWorkbookService {
  constructor(
    private readonly db: AppDb,
    private readonly projectsSvc: ProjectService,
    private readonly planning: PlanningService,
    private readonly transformations: TransformationService,
    private readonly analysis: AnalysisService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  /** The source half of a mapping: everything an analysis found, with the target columns blank. */
  async forAnalysis(ctx: RequestContext, analysisRunId: string) {
    const run = await this.analysis.get(ctx, analysisRunId);
    if (run.status !== 'COMPLETED') {
      throw badRequest('Wait for the analysis to finish before exporting its mapping workbook');
    }
    const profiles = await this.profilesFor(analysisRunId);
    const fieldRows: XlsxValue[][] = [];
    for (const table of run.tables) {
      const profile = profiles.get(table.logicalName);
      for (const field of profile?.fields ?? []) {
        fieldRows.push([...sourceCells(table.logicalName, field, table.recordCount), '', '', '', '']);
      }
    }

    const book = writeXlsx([
      overviewSheet({
        title: run.name,
        source: run.environment.displayName,
        target: null,
        basis: run.basis,
        when: run.completedAt ?? run.createdAt,
        lines: [
          `Tables analysed: ${run.totals.tables}`,
          `Columns: ${run.totals.columns}`,
          `Records: ${run.totals.records.toLocaleString()}${run.totals.recordsApproximate ? ' (estimated)' : ''}`,
          `Findings: ${run.totals.blockers} blocker(s), ${run.totals.warnings} warning(s)`,
        ],
      }),
      tablesSheet(run),
      fieldSheet(fieldRows, false),
      ...transformationSheets([]),
      findingsSheet(await this.analysis.findings(ctx, analysisRunId)),
    ]);

    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'MAPPING_WORKBOOK_EXPORTED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: run.environment.id,
      requestId: ctx.requestId,
      details: { analysisRunId, rows: fieldRows.length },
    });
    return { filename: workbookName(['mapping', run.name]), buffer: book };
  }

  /**
   * Both halves: the plan's current target mapping, with the source facts from the analysis the
   * project was started from when there is one. This is the sheet that goes out for review.
   */
  async forPlan(ctx: RequestContext, planId: string) {
    const plan = await this.planning.get(ctx, planId);
    const entities = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(eq(migrationPlanEntities.planId, planId))
      .orderBy(asc(migrationPlanEntities.orderIndex));
    const mappings = entities.length
      ? await this.db
          .select()
          .from(fieldMappings)
          .where(
            inArray(
              fieldMappings.planEntityId,
              entities.map((e) => e.id),
            ),
          )
          .orderBy(asc(fieldMappings.sourceField))
      : [];
    const byEntity = new Map(entities.map((e) => [e.id, e]));

    // The analysis this migration was informed by, if any: its profile fills the source columns.
    const analysis = await this.analysisForPlan(ctx, planId);
    const profiles = analysis ? await this.profilesFor(analysis.id) : new Map<string, TableProfileDto>();
    const recordCounts = new Map((analysis?.tables ?? []).map((t) => [t.logicalName, t.recordCount]));

    const fieldRows: XlsxValue[][] = [];
    const pipelines: FieldPipeline[] = [];
    for (const m of mappings) {
      const entity = byEntity.get(m.planEntityId);
      if (!entity) continue;
      const profile = profiles.get(entity.logicalName);
      const field = profile?.fields.find((f) => f.field === m.sourceField);
      const records = recordCounts.get(entity.logicalName) ?? entity.sourceCount ?? 0;
      fieldRows.push([
        ...(field
          ? sourceCells(entity.logicalName, field, records)
          : // No analysis to draw on: the source facts are whatever the plan itself knows.
            [entity.logicalName, m.sourceField, m.sourceType, '', '', records, '', '', '', '']),
        entity.targetLogicalName ?? '',
        m.status === 'IGNORED' ? IGNORE_TOKEN : (m.targetField ?? ''),
        summarizeRules(m.transformations ?? []),
        m.reason ?? '',
      ]);
      if (m.transformations?.length) {
        pipelines.push({
          table: entity.logicalName,
          field: m.sourceField,
          rules: m.transformations,
        });
      }
    }

    const book = writeXlsx([
      overviewSheet({
        title: plan.name,
        source: plan.sourceEnvironment.displayName,
        target: plan.targetEnvironment.displayName,
        basis: analysis?.basis ?? null,
        when: new Date().toISOString(),
        lines: [
          `Tables: ${plan.entities.length}`,
          `Mapped columns: ${mappings.filter((m) => m.targetField).length} of ${mappings.length}`,
          analysis
            ? `Source facts from analysis: ${analysis.name}`
            : 'No analysis linked, so the source statistics columns are blank.',
        ],
      }),
      planTablesSheet(plan, analysis),
      fieldSheet(fieldRows, true),
      ...transformationSheets(pipelines),
      findingsSheet(analysis ? await this.analysis.findings(ctx, analysis.id) : []),
    ]);

    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'MAPPING_WORKBOOK_EXPORTED',
      outcome: 'SUCCESS',
      sourceEnvironmentId: plan.sourceEnvironment.id,
      targetEnvironmentId: plan.targetEnvironment.id,
      requestId: ctx.requestId,
      details: { planId, rows: fieldRows.length, analysisRunId: analysis?.id ?? null },
    });
    return { filename: workbookName(['mapping', plan.name]), buffer: book };
  }

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------

  /**
   * Applies a returned workbook to a plan.
   *
   * Defaults to a dry run, because a mapping sheet arrives by email and nobody should discover what
   * it contained by watching it take effect. Every row goes through `PlanningService.updateMapping`,
   * so a target column that does not exist, is the wrong type, or is already taken is refused here
   * exactly as it would be on screen — and refused individually, naming the row.
   */
  async importIntoPlan(
    ctx: RequestContext,
    planId: string,
    file: { content: Buffer; filename?: string },
    opts: { apply?: boolean } = {},
  ): Promise<MappingImportPreviewDto> {
    if (file.content.length === 0) throw badRequest('The uploaded file is empty');
    if (file.content.length > MAX_IMPORT_BYTES) {
      throw badRequest(`That file is larger than the ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB limit`);
    }
    // The gate every sibling method already had and this one did not. Without it, a preview built
    // from another organization's plan was returned to the caller: its tables, its columns and
    // its current target mappings. Reads there are as much a breach as writes.
    await this.planning.get(ctx, planId);
    const parsed = parseWorkbook(file.content, file.filename);
    const rows = parsed.mappings;
    if (rows.length > MAX_IMPORT_ROWS) {
      throw badRequest(`The workbook has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}`);
    }

    const entities = await this.db
      .select()
      .from(migrationPlanEntities)
      .where(eq(migrationPlanEntities.planId, planId));
    if (entities.length === 0) throw badRequest('Add tables to this plan before importing a mapping');
    const mappings = await this.db
      .select()
      .from(fieldMappings)
      .where(
        inArray(
          fieldMappings.planEntityId,
          entities.map((e) => e.id),
        ),
      );
    const entityByName = new Map(entities.map((e) => [e.logicalName.toLowerCase(), e]));
    const mappingKey = (entityId: string, field: string) => `${entityId}:${field.toLowerCase()}`;
    const mappingByKey = new Map(mappings.map((m) => [mappingKey(m.planEntityId, m.sourceField), m]));

    const preview: MappingImportPreviewDto = {
      matched: 0,
      unmatched: [],
      changes: [],
      rejected: [],
      transformationsChanged: 0,
      applied: opts.apply === true,
    };
    // A pipeline the sheets describe but this plan cannot hold is reported before anything is
    // applied, so a rejected transformation never looks like a silently ignored one.
    for (const problem of parsed.transformations.problems) {
      preview.rejected.push({
        row: problem.row,
        table: problem.table,
        field: problem.field,
        reason: `Transformations sheet: ${problem.reason}`,
      });
    }

    for (const row of rows) {
      const entity = entityByName.get(row.table.toLowerCase());
      if (!entity) {
        preview.unmatched.push({
          row: row.line,
          table: row.table,
          field: row.field,
          reason: 'That table is not in this plan',
        });
        continue;
      }
      const mapping = mappingByKey.get(mappingKey(entity.id, row.field));
      if (!mapping) {
        preview.unmatched.push({
          row: row.line,
          table: row.table,
          field: row.field,
          reason: 'That column is not in this plan',
        });
        continue;
      }
      preview.matched++;

      const current = mapping.status === 'IGNORED' ? IGNORE_TOKEN : (mapping.targetField ?? null);
      const wanted = row.targetField || null;
      const action = decideAction(current, wanted);
      const change: MappingImportChangeDto = {
        table: entity.logicalName,
        field: mapping.sourceField,
        from: current,
        to: wanted,
        action,
      };
      preview.changes.push(change);
      if (action === 'UNCHANGED') continue;

      if (!opts.apply) continue;
      try {
        if (wanted === null) {
          await this.planning.updateMapping(ctx, planId, mapping.id, { action: 'UNMAP' });
        } else if (isIgnoreToken(wanted)) {
          await this.planning.updateMapping(ctx, planId, mapping.id, { action: 'IGNORE' });
        } else {
          await this.planning.updateMapping(ctx, planId, mapping.id, {
            action: 'MAP',
            targetField: wanted,
          });
        }
      } catch (err) {
        change.action = 'UNCHANGED';
        preview.rejected.push({
          row: row.line,
          table: entity.logicalName,
          field: mapping.sourceField,
          reason: err instanceof Error ? err.message : 'The mapping was refused',
        });
        continue;
      }
    }

    // Transformations come from their own sheets, in full. Applied after the mappings, because a
    // pipeline belongs to a column that has somewhere to go.
    if (parsed.transformations.present) {
      for (const mapping of mappings) {
        const entity = entities.find((e) => e.id === mapping.planEntityId);
        if (!entity) continue;
        const wanted = parsed.transformations.byField.get(
          pipelineKey(entity.logicalName, mapping.sourceField),
        );
        // A column the sheet does not mention is left alone. Absence is not a decision: somebody
        // hand-writing a sheet to add one rule must not silently wipe every other pipeline. Clearing
        // one is said explicitly, with a NONE row.
        if (wanted === undefined) continue;
        const current = mapping.transformations ?? [];
        const next = wanted;
        if (JSON.stringify(current) === JSON.stringify(next)) continue;
        preview.transformationsChanged++;
        if (!opts.apply) continue;
        try {
          // The same path the transformation editor uses, so the rules are validated and audited
          // identically however they arrived.
          await this.transformations.updatePipeline(ctx, planId, mapping.id, next);
        } catch (err) {
          preview.transformationsChanged--;
          preview.rejected.push({
            row: 0,
            table: entity.logicalName,
            field: mapping.sourceField,
            reason: err instanceof Error ? err.message : 'The transformation was refused',
          });
        }
      }
    }

    if (opts.apply) {
      await this.planning.revalidate(ctx, planId);
      await this.audit.record({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        action: 'MAPPING_WORKBOOK_IMPORTED',
        outcome: 'SUCCESS',
        requestId: ctx.requestId,
        details: {
          planId,
          filename: file.filename ?? null,
          matched: preview.matched,
          changed: preview.changes.filter((c) => c.action !== 'UNCHANGED').length,
          transformationsChanged: preview.transformationsChanged,
          rejected: preview.rejected.length,
          unmatched: preview.unmatched.length,
        },
      });
      this.logger.info(
        { planId, matched: preview.matched, rejected: preview.rejected.length },
        'Mapping workbook imported',
      );
    }
    return preview;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async profilesFor(analysisRunId: string): Promise<Map<string, TableProfileDto>> {
    const rows = await this.db
      .select({ logicalName: analysisTables.logicalName, profile: analysisTables.profile })
      .from(analysisTables)
      .where(eq(analysisTables.analysisRunId, analysisRunId));
    return new Map(rows.map((r) => [r.logicalName, r.profile]));
  }

  /** The analysis behind a plan: its project's linked analysis project, newest completed run. */
  private async analysisForPlan(ctx: RequestContext, planId: string): Promise<AnalysisRunDto | null> {
    const plan = await this.planning.get(ctx, planId);
    if (!plan.projectId) return null;
    const project = await this.projectsSvc.row(ctx, plan.projectId);
    if (!project.analysisProjectId) return null;
    return this.analysis.latestCompleted(ctx, project.analysisProjectId);
  }
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** What someone types in the Target field column to say "deliberately not migrated". */
const IGNORE_TOKEN = 'IGNORE';
const isIgnoreToken = (value: string) => value.trim().toUpperCase() === IGNORE_TOKEN;

function overviewSheet(input: {
  title: string;
  source: string;
  target: string | null;
  basis: string | null;
  when: string;
  lines: string[];
}): XlsxSheet {
  const rows: XlsxValue[][] = [
    ['Name', input.title],
    ['Source', input.source],
    ...(input.target ? [['Target', input.target] as XlsxValue[]] : []),
    ['Produced', input.when],
    [
      'Statistics',
      input.basis === 'EXACT'
        ? 'Exact: every record was examined'
        : input.basis === 'SAMPLED'
          ? 'Sampled: the counts are a floor, not a total'
          : 'Not measured',
    ],
    ...input.lines.map((l) => ['', l] as XlsxValue[]),
  ];
  return {
    name: 'Overview',
    columns: [
      { header: 'Item', width: 22 },
      { header: 'Value', width: 80 },
    ],
    rows,
    notes: [
      'Fill in the Target table and Target field columns on the "Field mapping" sheet, then import this file back into the migration project.',
      `Write ${IGNORE_TOKEN} in Target field for a column that should deliberately not be migrated. Leave it blank to leave the decision open.`,
      'The Source columns are facts measured from the source. Editing them changes nothing.',
      'Transformations are edited on the "Transformations" sheet (with "Value maps" and "Concat parts" for their list-valued parts). The Transformation column on Field mapping is a read-only summary.',
      'Nothing is applied until you import the file and confirm what it would change.',
    ],
  };
}

function tablesSheet(run: AnalysisRunDto): XlsxSheet {
  return {
    name: 'Tables',
    columns: [
      { header: 'Source table', width: 34 },
      { header: 'Display name', width: 30 },
      { header: 'Records', width: 14 },
      { header: 'Estimated', width: 11 },
      { header: 'Columns', width: 10 },
      { header: 'Examined', width: 12 },
      { header: 'Statistics', width: 12 },
      { header: 'Blockers', width: 10 },
      { header: 'Warnings', width: 10 },
      { header: 'Load order', width: 11 },
      { header: 'Depends on', width: 40 },
      { header: 'Empty columns', width: 40 },
      { header: 'Target table', width: 30 },
    ],
    rows: run.tables.map((t) => [
      t.logicalName,
      t.displayName,
      t.recordCount,
      t.recordCountApproximate ? 'yes' : '',
      t.columnCount,
      t.examined,
      t.basis,
      t.blockers,
      t.warnings,
      t.orderIndex + 1,
      t.dependsOn.join(', '),
      t.emptyColumns.join(', '),
      '',
    ]),
    notes: ['Load order is a dependency-safe sequence: a table is listed after everything it points at.'],
  };
}

function planTablesSheet(
  plan: {
    entities: {
      logicalName: string;
      displayName: string;
      targetLogicalName?: string | null;
      sourceCount?: number | null;
    }[];
  },
  analysis: AnalysisRunDto | null,
): XlsxSheet {
  const byName = new Map((analysis?.tables ?? []).map((t) => [t.logicalName, t]));
  return {
    name: 'Tables',
    columns: [
      { header: 'Source table', width: 34 },
      { header: 'Display name', width: 30 },
      { header: 'Records', width: 14 },
      { header: 'Blockers', width: 10 },
      { header: 'Warnings', width: 10 },
      { header: 'Target table', width: 30 },
    ],
    rows: plan.entities.map((e) => {
      const analysed = byName.get(e.logicalName);
      return [
        e.logicalName,
        e.displayName,
        analysed?.recordCount ?? e.sourceCount ?? 0,
        analysed?.blockers ?? '',
        analysed?.warnings ?? '',
        e.targetLogicalName ?? '',
      ];
    }),
  };
}

/** The sheet that is read back. Its header labels are the contract. */
const WIDE_MAPPING_COLUMNS = new Set<string>(['Sample value', 'Notes', 'Transformation (reference)']);

function fieldSheet(rows: XlsxValue[][], hasTargets: boolean): XlsxSheet {
  return {
    name: 'Field mapping',
    columns: MAPPING_SHEET_COLUMNS.map((header) => ({
      header,
      // The columns that hold prose need the room; the rest size to their heading.
      width: WIDE_MAPPING_COLUMNS.has(header) ? 34 : undefined,
    })),
    rows,
    notes: [
      hasTargets
        ? 'Target table and Target field are read back on import. Everything else on this sheet is reference.'
        : 'Fill in Target table and Target field. Import this sheet into a migration project to apply them.',
      `Target field: a column name, blank to leave undecided, or ${IGNORE_TOKEN} to exclude the column deliberately.`,
      'Transformation (reference) is a summary only. Edit pipelines on the "Transformations" sheet.',
    ],
  };
}

function findingsSheet(
  findings: {
    table: string;
    field: string | null;
    severity: string;
    code: string;
    message: string;
    affected: number;
    basis: string;
    resolution: string | null;
  }[],
): XlsxSheet {
  return {
    name: 'Findings',
    columns: [
      { header: 'Table', width: 30 },
      { header: 'Field', width: 26 },
      { header: 'Severity', width: 11 },
      { header: 'Code', width: 26 },
      { header: 'Finding', width: 60 },
      { header: 'Affected', width: 12 },
      { header: 'Statistics', width: 12 },
      { header: 'Suggested resolution', width: 50 },
    ],
    rows: findings.map((f) => [
      f.table,
      f.field ?? '',
      f.severity,
      f.code,
      f.message,
      f.affected,
      f.basis,
      f.resolution ?? '',
    ]),
  };
}

/** The ten source columns, measured rather than asserted. */
function sourceCells(table: string, field: FieldProfileDto, records: number): XlsxValue[] {
  const sample = field.topValues.find((v) => v.value !== null && v.value !== '');
  return [
    table,
    field.field,
    field.type,
    field.issues.some((i) => i.code === 'REQUIRED_VALUE_MISSING') ? 'yes' : '',
    field.maxLength ?? '',
    records,
    field.nullCount,
    field.blankCount,
    field.distinctCount ?? '',
    sample?.value ?? '',
  ];
}

const workbookName = (parts: string[]) =>
  `${parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)}-${new Date().toISOString().slice(0, 10)}.xlsx`;

// ---------------------------------------------------------------------------
// Reading a returned workbook
// ---------------------------------------------------------------------------

interface ImportRow {
  line: number;
  table: string;
  field: string;
  targetField: string;
}

/**
 * Pulls the mapping rows out of a returned file.
 *
 * Accepts the workbook we produced, a workbook Excel rewrote, and a CSV saved from either — because
 * somebody always sends back a CSV. The sheet is found by its header labels rather than its
 * position, so reordered columns and extra notes above the header keep working.
 */
export function parseWorkbook(
  content: Buffer,
  filename?: string,
): { mappings: ImportRow[]; transformations: ReturnType<typeof readTransformationSheets> } {
  const looksZip = content.length > 4 && content[0] === 0x50 && content[1] === 0x4b;
  const sheets = looksZip ? readSheets(content) : [{ name: 'csv', rows: csvRows(content) }];
  const mappings = findMappingRows(sheets);
  if (mappings === null) {
    throw badRequest(
      `Could not find a sheet with "Source table", "Source field" and "Target field" columns in ${filename ?? 'that file'}. Export the mapping workbook and fill in that sheet.`,
    );
  }
  return { mappings, transformations: readTransformationSheets(sheets) };
}

function readSheets(content: Buffer): XlsxReadSheet[] {
  try {
    return readXlsx(content);
  } catch (err) {
    throw badRequest(
      `That file could not be read as a workbook: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
}

const csvRows = (content: Buffer): (string | number | boolean | null)[][] =>
  parseCsvRows(stripBom(content.toString('utf8')));

function findMappingRows(sheets: XlsxReadSheet[]): ImportRow[] | null {
  for (const sheet of sheets) {
    const found = rowsByHeader(sheet, ['Source table', 'Source field', 'Target field']);
    if (!found) continue;
    return found.rows.map((r, i) => ({
      // The sheet's own row number, so a rejection names something the reader can find.
      line: i + 1,
      table: r.sourcetable ?? '',
      field: r.sourcefield ?? '',
      targetField: r.targetfield ?? '',
    }));
  }
  return null;
}

/** A CSV saved by Excel starts with a byte-order mark, which is not part of the first header. */
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** RFC 4180 enough: quoted fields, doubled quotes inside them, CRLF or LF. */
/**
 * Reads delimited text.
 *
 * `delimiter` exists because a semicolon- or tab-separated file used to be rewritten into a
 * comma-separated one before parsing, and that rewrite had to do something about the commas already in
 * the data — it turned them into spaces. So `Smith, John` in an unquoted field of a European CSV became
 * `Smith John`, silently, before anything else in the product saw the value. Parsing with the real
 * delimiter is both simpler and lossless.
 */
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function decideAction(current: string | null, wanted: string | null): MappingImportChangeDto['action'] {
  if ((current ?? '') === (wanted ?? '')) return 'UNCHANGED';
  if (wanted === null) return 'MAP';
  if (isIgnoreToken(wanted)) return 'IGNORE';
  return current ? 'REMAP' : 'MAP';
}

// ---------------------------------------------------------------------------
// Transformations as text
// ---------------------------------------------------------------------------

/** Kinds whose whole configuration is one simple argument, so they survive a round trip as text. */
/** Marks a rule whose configuration the sheet cannot express, so the importer refuses it. */
const ELLIPSIS = '…';

const SIMPLE_ARG: Partial<Record<TransformationKind, 'number' | 'string'>> = {
  TRUNCATE: 'number',
  TO_DECIMAL: 'number',
  PREFIX: 'string',
  SUFFIX: 'string',
  CONSTANT: 'string',
  DEFAULT_IF_NULL: 'string',
  DEFAULT_IF_BLANK: 'string',
};
const NO_ARG: TransformationKind[] = [
  'TRIM',
  'LEFT_TRIM',
  'RIGHT_TRIM',
  'UPPERCASE',
  'LOWERCASE',
  'EMPTY_TO_NULL',
  'NULL_TO_EMPTY',
  'BLOCK_IF_NULL',
  'TO_STRING',
  'TO_INTEGER',
  'TO_BOOLEAN',
  'TO_DATE',
  'TO_DATETIME',
  'TO_GUID',
];

/** `TRIM > TRUNCATE(160)`. Rules the text form cannot express are named, never silently dropped. */
export function describeRules(rules: TransformationRule[]): string {
  return rules
    .map((rule) => {
      if (NO_ARG.includes(rule.kind)) return rule.kind;
      const arg = SIMPLE_ARG[rule.kind];
      if (arg === 'number') {
        const n = rule.kind === 'TO_DECIMAL' ? rule.scale : rule.length;
        return n == null ? rule.kind : `${rule.kind}(${n})`;
      }
      if (arg === 'string') {
        return rule.value == null ? rule.kind : `${rule.kind}(${String(rule.value)})`;
      }
      if (rule.kind === 'SUBSTRING') return `SUBSTRING(${rule.start ?? 0},${rule.length ?? 0})`;
      if (rule.kind === 'REPLACE') return `REPLACE(${rule.find ?? ''},${rule.replaceWith ?? ''})`;
      // Value maps, concatenations and conditionals are configured on screen; the text form says so
      // rather than pretending to describe them.
      return `${rule.kind}(${ELLIPSIS})`;
    })
    .join(' > ');
}

type ParseResult = { ok: true; rules: TransformationRule[] } | { ok: false; reason: string };

/** The inverse, for the kinds `describeRules` can state exactly. */
export function parseRules(text: string): ParseResult {
  const rules: TransformationRule[] = [];
  for (const piece of text.split('>')) {
    const token = piece.trim();
    if (!token) continue;
    const match = token.match(/^([A-Za-z_]+)\s*(?:\(([^)]*)\))?$/);
    if (!match) return { ok: false, reason: `"${token}" is not a transformation` };
    const kind = match[1].toUpperCase() as TransformationKind;
    const raw = match[2];
    if (!TRANSFORMATION_KINDS.includes(kind))
      return { ok: false, reason: `"${match[1]}" is not a known rule` };
    if (raw === ELLIPSIS || raw === '...') {
      return { ok: false, reason: `${kind} is configured in the app, not in the sheet` };
    }
    if (NO_ARG.includes(kind)) {
      if (raw) return { ok: false, reason: `${kind} takes no argument` };
      rules.push({ kind });
      continue;
    }
    const arg = SIMPLE_ARG[kind];
    if (arg === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0)
        return { ok: false, reason: `${kind} needs a number, got "${raw ?? ''}"` };
      rules.push(kind === 'TO_DECIMAL' ? { kind, scale: n } : { kind, length: n });
      continue;
    }
    if (arg === 'string') {
      if (raw === undefined) return { ok: false, reason: `${kind} needs a value` };
      rules.push({ kind, value: raw });
      continue;
    }
    if (kind === 'SUBSTRING') {
      const [start, length] = (raw ?? '').split(',').map((v) => Number(v.trim()));
      if (!Number.isFinite(start) || !Number.isFinite(length)) {
        return { ok: false, reason: 'SUBSTRING needs a start and a length, e.g. SUBSTRING(0,10)' };
      }
      rules.push({ kind, start, length });
      continue;
    }
    if (kind === 'REPLACE') {
      const idx = (raw ?? '').indexOf(',');
      if (idx < 0)
        return { ok: false, reason: 'REPLACE needs what to find and what to put, e.g. REPLACE(a,b)' };
      rules.push({ kind, find: raw!.slice(0, idx), replaceWith: raw!.slice(idx + 1) });
      continue;
    }
    return { ok: false, reason: `${kind} is configured in the app, not in the sheet` };
  }
  return { ok: true, rules };
}
