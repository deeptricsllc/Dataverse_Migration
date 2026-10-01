import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { AGGREGATE_CAVEAT } from '../../../shared/aggregates';
import type { MigrationRunDto, ValidationRunDto } from '../../../shared/domain';
import { accountedFor, writtenByRun } from '../../../shared/run-metrics';
import {
  CAPABILITY_LABELS,
  CONNECTOR_VERIFICATION,
  VERIFICATION_LABELS,
  type ConnectorCapabilityKey,
} from '../../../shared/connector-verification';
import { coveragePercent, describeCoverage } from '../../../shared/validation-coverage';
import { csvCell } from '../lib/csv';
import { writeZip, type ZipEntry } from '../lib/zip';
import type { RequestContext } from './context';
import type { MigrationRunService } from './migration-run-service';
import type { ValidationService } from './validation-service';
import type { PlanningService } from './planning-service';

/**
 * Everything a migration lead should still have in six months.
 *
 * The product already answers "what happened" on screen. This answers it to somebody who was not
 * there — an auditor, a data owner, the person who inherits the system — after the environments
 * have moved on and nobody can re-run anything. So it is deliberately not a prettier version of the
 * report: it is the configuration that produced the run, the numbers under their exact definitions,
 * what validation examined and what it did not, and how much the connector doing the work had
 * itself been verified.
 *
 * That last part is the one most reports leave out. A clean validation over a connector that has
 * never been run against the real engine is a weaker statement than the same validation over one
 * that has, and a package that hides the difference is doing the reader a disservice.
 *
 * Never contains a credential. `assertNoSecrets` is the backstop, and a test scans a generated
 * bundle rather than trusting that nobody will add one later.
 */

export interface EvidenceBundle {
  filename: string;
  zip: Buffer;
  manifest: EvidenceManifest;
}

export interface EvidenceManifest {
  /** Bumped when the shape changes, so a reader knows what they are holding. */
  schema: 1;
  generatedAt: string;
  run: {
    id: string;
    planName: string;
    projectName: string | null;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    source: { name: string; connectionType: string };
    target: { name: string; connectionType: string };
  };
  files: EvidenceFileRecord[];
  integrity: {
    algorithm: 'sha256';
    /** What the hashes do and do not establish, stated so nobody reads more into them. */
    proves: string;
    doesNotProve: string;
  };
}

export interface EvidenceFileRecord {
  path: string;
  bytes: number;
  sha256: string;
  /** What a reader can learn from this file. */
  describes: string;
}

export class EvidenceService {
  constructor(
    private readonly runs: MigrationRunService,
    private readonly validation: ValidationService,
    private readonly planning: PlanningService,
    private readonly logger: Logger,
  ) {}

  async bundleForRun(ctx: RequestContext, runId: string): Promise<EvidenceBundle> {
    const run = await this.runs.get(ctx, runId);
    const report = run.latestValidationRunId
      ? await this.validation.get(ctx, run.latestValidationRunId).catch(() => null)
      : null;
    const plan = await this.planning.get(ctx, run.planId).catch(() => null);

    const entries: { entry: ZipEntry; describes: string }[] = [
      {
        entry: file('summary.md', summaryMarkdown(run, report)),
        describes: 'A human-readable account of the run and what validation could say about it.',
      },
      {
        entry: file('metrics.csv', metricsCsv(run)),
        describes: 'Record outcomes per table, under the definitions in summary.md.',
      },
      {
        entry: file('configuration.json', configurationJson(run, plan)),
        describes: 'The settings that produced this run. Mappings, transformations, policies.',
      },
      {
        entry: file('connector-evidence.csv', connectorEvidenceCsv(run)),
        describes: 'How far each connector involved has itself been verified, capability by capability.',
      },
    ];
    if (report) {
      entries.push({
        entry: file('validation.csv', validationCsv(report)),
        describes: 'Per-table validation outcome, coverage and counts.',
      });
      entries.push({
        entry: file('validation-coverage.json', coverageJson(report)),
        describes: 'What was examined, what was not, and how the examined records were chosen.',
      });
      if (report.entities.some((e) => (e.aggregates ?? []).length > 0)) {
        entries.push({
          entry: file('aggregates.csv', aggregatesCsv(report)),
          describes: `Totals compared across the two sides, with the scope each figure covers. ${AGGREGATE_CAVEAT}`,
        });
      }
    }

    // The manifest is written last because it describes the others, and it is not itself hashed:
    // a file cannot contain its own digest.
    const files: EvidenceFileRecord[] = entries.map(({ entry, describes }) => ({
      path: entry.path,
      bytes: entry.data.length,
      sha256: createHash('sha256').update(entry.data).digest('hex'),
      describes,
    }));

    const manifest: EvidenceManifest = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      run: {
        id: run.id,
        planName: run.planName,
        projectName: null,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        source: {
          name: run.sourceEnvironment.displayName,
          connectionType: run.sourceEnvironment.connectionType ?? 'DATAVERSE',
        },
        target: {
          name: run.targetEnvironment.displayName,
          connectionType: run.targetEnvironment.connectionType ?? 'DATAVERSE',
        },
      },
      files,
      integrity: {
        algorithm: 'sha256',
        proves:
          'Each file listed here hashes to the recorded digest, so a file changed after the bundle was made no longer matches its manifest.',
        doesNotProve:
          'Nothing about who made the bundle or when. The manifest is not signed, so somebody who edits a file can recompute its digest and edit this too. It detects accidental change and casual tampering; it is not a cryptographic signature and must not be described as one.',
      },
    };

    const all: ZipEntry[] = [
      ...entries.map((e) => e.entry),
      file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`),
    ];
    for (const entry of all) assertNoSecrets(entry);

    this.logger.info({ runId, files: all.length }, 'Evidence bundle generated');
    return {
      filename: `migration-evidence-${run.id}.zip`,
      zip: writeZip(all),
      manifest,
    };
  }
}

function file(path: string, body: string): ZipEntry {
  return { path, data: Buffer.from(body, 'utf8') };
}

/**
 * A last line of defence rather than the only one.
 *
 * Nothing upstream puts a credential into any of these files — the DTOs do not carry one and no
 * route returns one. This exists because "nothing upstream does X" is a statement about today, and
 * a bundle is the kind of artefact that gets emailed.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/"?password"?\s*[:=]\s*"[^"]+"/i, 'a password field'],
  [/\b(client_secret|clientSecret|refresh_token|access_token|bearer)\b\s*[:=]/i, 'a token field'],
  [/\b[A-Za-z]+:\/\/[^\s/@]+:[^\s/@]+@/, 'a connection string carrying a credential'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
];

export function assertNoSecrets(entry: ZipEntry): void {
  const text = entry.data.toString('utf8');
  for (const [pattern, what] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Evidence bundle refused: ${entry.path} appears to contain ${what}.`);
    }
  }
}

function summaryMarkdown(run: MigrationRunDto, report: ValidationRunDto | null): string {
  const written = writtenByRun(run);
  const lines: string[] = [
    `# Migration evidence`,
    ``,
    `**Plan** ${run.planName}  `,
    `**Run** ${run.id}  `,
    `**Source** ${run.sourceEnvironment.displayName}  `,
    `**Target** ${run.targetEnvironment.displayName}  `,
    `**Status** ${run.status}  `,
    `**Started** ${run.startedAt ?? 'not recorded'}  `,
    `**Finished** ${run.completedAt ?? 'not recorded'}`,
    ``,
    `## What this run did with each record`,
    ``,
    `Every record the run reached a decision about falls into exactly one of these, and they sum`,
    `to the processed total.`,
    ``,
    `| Outcome | Records | Meaning |`,
    `| --- | ---: | --- |`,
    `| Created | ${run.created} | Did not exist in the target. This run inserted them. |`,
    `| Updated | ${run.updated} | Existed and differed. This run changed them. |`,
    `| Unchanged | ${run.unchanged} | Existed and already matched. Nothing was sent. |`,
    `| Skipped | ${run.skipped} | Existed and were left alone by the conflict rules. In the target, but not this run's doing. |`,
    `| Failed | ${run.failed} | Attempted and not written. Not in the target. |`,
    `| **Processed** | **${run.processed}** | The five above, added up. |`,
    `| **Written by this run** | **${written}** | Created plus updated. Nothing else. |`,
    ``,
  ];

  if (!report) {
    lines.push(
      `## Validation`,
      ``,
      `This run has not been validated. Nothing in this package states whether the records that`,
      `were written match their source.`,
      ``,
    );
  } else {
    const s = report.summary;
    lines.push(
      `## Validation`,
      ``,
      `**Outcome** ${report.outcome ?? 'not completed'}  `,
      `**Depth** ${report.depth}`,
      ``,
    );
    if (s?.coverage) {
      lines.push(
        `### Coverage`,
        ``,
        `${describeCoverage(s.coverage)}`,
        ``,
        `| | |`,
        `| --- | ---: |`,
        `| Mode | ${s.coverage.mode} |`,
        `| Eligible records | ${s.coverage.eligible} |`,
        `| Examined | ${s.coverage.examined} |`,
        `| Coverage | ${coveragePercent(s.coverage)}% |`,
        ``,
        `How those records were chosen: ${s.coverage.strategy}`,
        ``,
      );
      if (s.coverage.mode === 'SAMPLED') {
        lines.push(
          `> Nothing in this package claims anything about the`,
          `> ${s.coverage.eligible - s.coverage.examined} record(s) that were not examined.`,
          ``,
        );
      }
      if (s.coverage.mode === 'NOT_VERIFIED') {
        lines.push(`> At least one check could not run: ${s.coverage.reason ?? 'reason not recorded'}`, ``);
      }
    }
    if (s) {
      lines.push(
        `### Results`,
        ``,
        `| | |`,
        `| --- | ---: |`,
        `| Tables validated | ${s.tablesValidated} |`,
        `| Matched on every compared field | ${s.matchedRecords} |`,
        `| Missing from the target | ${s.missingRecords} |`,
        `| Present but differing | ${s.differentRecords} |`,
        `| Broken references | ${s.brokenReferences} |`,
        `| Records sharing a key that should be unique | ${s.duplicateRecords} |`,
        ``,
      );
    }
    const aggregates = report.entities.flatMap((e) => e.aggregates ?? []);
    if (aggregates.length > 0) {
      const compared = aggregates.filter((a) => a.outcome !== 'NOT_VERIFIED');
      const disagreed = aggregates.filter((a) => a.outcome === 'FAIL');
      lines.push(
        `### Totals compared`,
        ``,
        // Said before the number, so the number is read in the right frame rather than afterwards.
        `${AGGREGATE_CAVEAT}`,
        ``,
        compared.length === 0
          ? `No totals could be compared. ${aggregates[0]!.reason}`
          : `${compared.length} total(s) were compared across ${report.entities.filter((e) => (e.aggregates ?? []).length > 0).length} table(s). ` +
              (disagreed.length === 0
                ? `All of them agree.`
                : `${disagreed.length} disagree. \`aggregates.csv\` names which.`),
        ``,
        `${aggregates.length - compared.length} could not be compared, each with its reason in`,
        `\`aggregates.csv\`.`,
        ``,
      );
    }
  }

  lines.push(
    `## How far the connectors themselves are verified`,
    ``,
    `A clean validation over a connector that has never been run against the real engine is a`,
    `weaker statement than the same validation over one that has. \`connector-evidence.csv\` gives`,
    `this capability by capability.`,
    ``,
    `## Integrity`,
    ``,
    `\`manifest.json\` records a SHA-256 digest for every other file. A file changed afterwards no`,
    `longer matches its digest. The manifest is **not signed**: somebody who edits a file can`,
    `recompute its digest and edit the manifest too. This detects accidental change and casual`,
    `tampering. It is not a cryptographic signature and should not be described as one.`,
    ``,
  );
  return lines.join('\n');
}

function metricsCsv(run: MigrationRunDto): string {
  const rows = [
    [
      'Table',
      'Total',
      'Processed',
      'Created',
      'Updated',
      'Unchanged',
      'Skipped',
      'Failed',
      'Written by this run',
    ],
    ...run.entities.map((e) => [
      e.logicalName,
      e.total,
      e.processed,
      e.created,
      e.updated,
      e.unchanged,
      e.skipped,
      e.failed,
      e.created + e.updated,
    ]),
    [
      'ALL TABLES',
      run.total,
      run.processed,
      run.created,
      run.updated,
      run.unchanged,
      run.skipped,
      run.failed,
      writtenByRun(run),
    ],
  ];
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function validationCsv(report: ValidationRunDto): string {
  const rows = [
    [
      'Table',
      'Outcome',
      'Coverage mode',
      'Eligible',
      'Examined',
      'Coverage %',
      'Matched',
      'Missing',
      'Different',
      'Broken references',
      'Duplicate records',
      'Duplicate check',
    ],
    ...report.entities.map((e) => [
      e.logicalName,
      e.outcome,
      e.coverage?.mode ?? 'NOT RECORDED',
      e.coverage?.eligible ?? '',
      e.coverage?.examined ?? '',
      e.coverage ? coveragePercent(e.coverage) : '',
      e.matched,
      e.missing,
      e.different,
      e.brokenReferences,
      (e.duplicates ?? []).reduce((n, d) => n + d.occurrences, 0),
      e.duplicateCoverage?.mode ?? 'NOT RECORDED',
    ]),
  ];
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/**
 * Totals, with the scope and the reason on every row.
 *
 * The scope column is not decoration. An auditor reading a spreadsheet of matching sums will draw a
 * conclusion from it, and the only thing that makes that conclusion safe is knowing which records
 * the two figures covered — so it travels in the row rather than in a header somebody scrolls past.
 */
function aggregatesCsv(report: ValidationRunDto): string {
  const rows = [
    ['Table', 'Aggregate', 'Column', 'Source value', 'Target value', 'Result', 'Scope', 'Reason'],
    ...report.entities.flatMap((e) =>
      (e.aggregates ?? []).map((a) => [
        a.entity,
        a.kind,
        a.column ?? '',
        a.sourceValue ?? '',
        a.targetValue ?? '',
        a.outcome === 'NOT_VERIFIED' ? 'NOT VERIFIED' : a.outcome,
        a.scope,
        a.reason,
      ]),
    ),
  ];
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function coverageJson(report: ValidationRunDto): string {
  return `${JSON.stringify(
    {
      depth: report.depth,
      outcome: report.outcome,
      summary: report.summary?.coverage ?? null,
      perTable: report.entities.map((e) => ({
        table: e.logicalName,
        records: e.coverage ?? null,
        duplicates: e.duplicateCoverage ?? null,
      })),
      note: 'SAMPLED means the records not examined are not described by this package at all. NOT_VERIFIED means a check could not run, which is not the same as passing.',
    },
    null,
    2,
  )}\n`;
}

function configurationJson(run: MigrationRunDto, plan: unknown): string {
  return `${JSON.stringify(
    {
      note: 'The settings that produced this run. Credentials are never included; connections appear by name only.',
      run: {
        id: run.id,
        planId: run.planId,
        planName: run.planName,
        attempt: run.attempt,
        options: run.options,
      },
      source: { name: run.sourceEnvironment.displayName },
      target: { name: run.targetEnvironment.displayName },
      plan: plan ?? 'The plan has been deleted or is no longer readable.',
    },
    null,
    2,
  )}\n`;
}

function connectorEvidenceCsv(run: MigrationRunDto): string {
  const involved = [
    ['source', run.sourceEnvironment.connectionType ?? 'DATAVERSE'],
    ['target', run.targetEnvironment.connectionType ?? 'DATAVERSE'],
  ] as const;
  const rows: unknown[][] = [
    ['Role', 'Connector', 'Capability', 'Verification', 'What that means', 'Evidence'],
  ];
  for (const [role, type] of involved) {
    const matrix = CONNECTOR_VERIFICATION[type as keyof typeof CONNECTOR_VERIFICATION];
    if (!matrix) continue;
    for (const [capability, level] of Object.entries(matrix)) {
      const meta = VERIFICATION_LABELS[level!];
      rows.push([
        role,
        type,
        CAPABILITY_LABELS[capability as ConnectorCapabilityKey],
        meta.label,
        meta.meaning,
        meta.evidence,
      ]);
    }
  }
  return rows.map((r) => r.map((v) => csvCell(v as never)).join(',')).join('\r\n');
}

/** Exported for the invariant tests: the bundle must agree with the run it describes. */
export function reconcile(run: MigrationRunDto): { written: number; accounted: number } {
  return { written: writtenByRun(run), accounted: accountedFor(run) };
}
