import type { Logger } from 'pino';
import { and, asc, count, eq, gt, sql } from 'drizzle-orm';
import { AGGREGATE_CAVEAT } from '../../../shared/aggregates';
import {
  EVIDENCE_SCHEMA_VERSION,
  INTEGRITY_DOES_NOT_PROVE,
  INTEGRITY_PROVES,
  LINEAGE_COLUMNS,
  type EvidenceFileRecord,
  type EvidenceLineageSummary,
  type EvidenceManifest,
  type EvidenceRecoverySummary,
} from '../../../shared/evidence';
import type { AppConfig } from '../config';
import { buildIdentity, describeBuild } from '../build-info';
import type { AppDb } from '../db/client';
import { migrationRecordMaps, migrationRuns } from '../db/schema';
import { ZipStream } from '../lib/zip-stream';
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
import type { ZipEntry } from '../lib/zip';
import type { RequestContext } from './context';
import type { MigrationRunService } from './migration-run-service';
import type { ValidationService } from './validation-service';
import type { PlanningService } from './planning-service';
import type { ReadinessService } from './readiness-service';

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

/**
 * A package written as it is read, for runs too large to hold.
 *
 * `manifest` resolves once the manifest is known, which is just before the last byte leaves: the
 * manifest is the final entry, so by then every other file has been hashed. A caller that needs to
 * audit the export can await it without waiting for the download to finish.
 */
export type { EvidenceManifest, EvidenceFileRecord } from '../../../shared/evidence';

export interface EvidenceStream {
  filename: string;
  output: NodeJS.ReadableStream;
  manifest: Promise<EvidenceManifest>;
}

/** Lineage rows per chunk. Chosen so one chunk opens in a spreadsheet without complaint. */
const LINEAGE_CHUNK_ROWS = 50_000;
/** Rows fetched from the identity map at a time. Bounded regardless of the chunk size. */
const LINEAGE_PAGE = 500;

export class EvidenceService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDb,
    private readonly runs: MigrationRunService,
    private readonly validation: ValidationService,
    private readonly planning: PlanningService,
    private readonly readiness: ReadinessService,
    private readonly logger: Logger,
  ) {}

  /**
   * The same package, streamed.
   *
   * Everything but lineage is small and built in memory as before. Lineage is one row per record the
   * run touched, which on a large migration is the only part that does not fit — so it is read from
   * the identity map a page at a time and written into chunk files as it goes. The archive is
   * streamed for the same reason: holding the zip would undo the point of not holding the rows.
   */
  async streamBundleForRun(ctx: RequestContext, runId: string): Promise<EvidenceStream> {
    const prepared = await this.prepare(ctx, runId);
    const zip = new ZipStream();
    let settle: (manifest: EvidenceManifest) => void = () => {};
    let fail: (err: unknown) => void = () => {};
    const manifest = new Promise<EvidenceManifest>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    // Written in the background while the caller pipes `output` somewhere.
    void (async () => {
      try {
        const describes = new Map<string, string>();
        for (const item of prepared.entries) {
          assertNoSecrets(item.entry);
          await zip.add(item.entry.path, item.entry.data);
          describes.set(item.entry.path, item.describes);
        }
        const lineage = await this.writeLineage(zip, prepared.run.id, prepared.targetNames);
        for (const path of lineage?.files ?? []) {
          describes.set(path, 'One row per record this run touched: where it came from and where it went.');
        }
        const built = this.manifestFor(prepared, zip.files, lineage, describes);
        const entry = file('manifest.json', `${JSON.stringify(built, null, 2)}\n`);
        assertNoSecrets(entry);
        await zip.add(entry.path, entry.data);
        settle(built);
        await zip.finish();
        this.logger.info(
          { runId, files: zip.files.length, lineageRows: lineage?.totalRows ?? 0 },
          'Evidence package streamed',
        );
      } catch (err) {
        fail(err);
        zip.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return { filename: `migration-evidence-${prepared.run.id}.zip`, output: zip.output, manifest };
  }

  /**
   * Lineage, written a chunk at a time.
   *
   * One row per record the run has an identity row for. A FAILED record keeps its source identity and
   * has no target key, because it was never written — inventing one there is the single lie that
   * would make the whole file useless. One row of lookahead, so the last chunk is never an empty file
   * claiming to hold rows.
   */
  private async writeLineage(
    zip: ZipStream,
    runId: string,
    targetNames: Map<string, string>,
  ): Promise<EvidenceLineageSummary | null> {
    const header = `\uFEFF${LINEAGE_COLUMNS.join(',')}\r\n`;
    const files: string[] = [];
    const rowsPerFile: number[] = [];
    let totalRows = 0;
    let rowsWithoutTarget = 0;

    const iterator = this.lineageRows(runId, targetNames)[Symbol.asyncIterator]();
    let next = await iterator.next();
    while (!next.done) {
      const path = `lineage/part-${String(files.length + 1).padStart(6, '0')}.csv`;
      let rows = 0;
      await zip.add(
        path,
        (async function* () {
          yield header;
          while (!next.done && rows < LINEAGE_CHUNK_ROWS) {
            const row = next.value;
            if (!row[5]) rowsWithoutTarget++;
            yield `${row.map((v) => csvCell(v)).join(',')}\r\n`;
            rows++;
            totalRows++;
            next = await iterator.next();
          }
        })(),
      );
      files.push(path);
      rowsPerFile.push(rows);
    }

    if (files.length === 0) return null;
    return { files, totalRows, rowsPerFile, chunkSize: LINEAGE_CHUNK_ROWS, rowsWithoutTarget };
  }

  /** The identity map as lineage rows, walked by keyset so a chunk boundary changes nothing. */
  private async *lineageRows(
    runId: string,
    targetNames: Map<string, string>,
  ): AsyncGenerator<(string | number)[]> {
    const scope = eq(migrationRecordMaps.runId, runId);
    let cursor: { logicalName: string; sourceId: string } | null = null;
    // Annotated rather than inferred: the cursor comes out of the page and goes back into the
    // query, and TypeScript cannot untangle that circle on its own.
    type LineageRow = {
      logicalName: string;
      sourceId: string;
      targetId: string | null;
      outcome: string;
      matchMethod: string | null;
      attempts: number;
      writeState: string | null;
      reconcileEvidence: string | null;
      reconcileNote: string | null;
    };
    for (;;) {
      const page: LineageRow[] = await this.db
        .select({
          logicalName: migrationRecordMaps.logicalName,
          sourceId: migrationRecordMaps.sourceId,
          targetId: migrationRecordMaps.targetId,
          outcome: migrationRecordMaps.outcome,
          matchMethod: migrationRecordMaps.matchMethod,
          attempts: migrationRecordMaps.attempts,
          writeState: migrationRecordMaps.writeState,
          reconcileEvidence: migrationRecordMaps.reconcileEvidence,
          reconcileNote: migrationRecordMaps.reconcileNote,
        })
        .from(migrationRecordMaps)
        .where(
          cursor === null
            ? scope
            : and(
                scope,
                // Ordered by table then source id, so the pair is the cursor.
                gt(
                  sql`(${migrationRecordMaps.logicalName}, ${migrationRecordMaps.sourceId})`,
                  sql`(${cursor.logicalName}, ${cursor.sourceId})`,
                ),
              ),
        )
        .orderBy(asc(migrationRecordMaps.logicalName), asc(migrationRecordMaps.sourceId))
        .limit(LINEAGE_PAGE);
      if (page.length === 0) return;
      for (const row of page) {
        yield [
          runId,
          row.attempts,
          row.logicalName,
          row.sourceId,
          targetNames.get(row.logicalName) ?? row.logicalName,
          row.targetId ?? '',
          row.outcome,
          row.matchMethod ?? '',
          // Whether the platform can prove it, and what it would take to find out.
          row.writeState ?? 'CONFIRMED',
          row.reconcileEvidence ?? '',
          row.reconcileNote ?? '',
        ];
      }
      const last = page[page.length - 1]!;
      cursor = { logicalName: last.logicalName, sourceId: last.sourceId };
      if (page.length < LINEAGE_PAGE) return;
    }
  }

  /**
   * Everything the package needs, gathered once, so the streamed and in-memory paths cannot drift.
   *
   * The two used to build their own file lists, which is how a format grows two definitions. This is
   * the only place that decides what a package contains.
   */
  private async prepare(ctx: RequestContext, runId: string) {
    const run = await this.runs.get(ctx, runId);
    const report = run.latestValidationRunId
      ? await this.validation.get(ctx, run.latestValidationRunId).catch(() => null)
      : null;
    const plan = await this.planning.get(ctx, run.planId).catch(() => null);

    const entries: { entry: ZipEntry; describes: string }[] = [
      {
        entry: file('summary.md', summaryMarkdown(run, report, describeBuild(buildIdentity(this.config)))),
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

    /**
     * What was known before the run, and what somebody decided to run past.
     *
     * The assessment this run was executed against, when it was recorded.
     *
     * It used to be re-assessed at packaging time and described as "the pre-migration assessment",
     * which it was not: a plan can be re-mapped after a run, and the target is populated by the run
     * itself, so a finding like TARGET_ALREADY_POPULATED means something different afterwards. A reader
     * following predicted risk to actual outcome was being handed the wrong half of the chain.
     *
     * A run from before this was recorded falls back to a current assessment — and the file says so,
     * rather than letting a fresh document wear the old one's label.
     */
    const [stored] = await this.db
      .select({ readiness: migrationRuns.readinessSnapshot })
      .from(migrationRuns)
      .where(eq(migrationRuns.id, run.id));
    const predicted = stored?.readiness ?? null;
    const readiness = predicted ?? (await this.readiness.assess(ctx, run.planId).catch(() => null));
    if (readiness) {
      entries.push({
        entry: file(
          'readiness.json',
          `${JSON.stringify(readiness, null, 2)}
`,
        ),
        describes: predicted
          ? 'The assessment this run was executed against, recorded before the work started: blockers, warnings, and any blocker accepted explicitly, with who accepted it and why.'
          : 'An assessment of the plan made when this package was built. This run predates the platform recording its assessment, so this is NOT what was predicted before the migration — the plan may have changed and the target is now populated.',
      });
    }

    // Which target table each source table was migrated into, from the run's own snapshot rather
    // than from the plan as it stands now — a plan can be re-mapped after a run.
    const [row] = await this.db
      .select({ snapshot: migrationRuns.planSnapshot, attempt: migrationRuns.attempt })
      .from(migrationRuns)
      .where(eq(migrationRuns.id, runId));
    const targetNames = new Map<string, string>(
      (row?.snapshot?.entities ?? []).map((e) => [e.logicalName, e.targetLogicalName]),
    );

    /**
     * What a crash left behind, and what became of it.
     *
     * Counted from the identity map rather than assembled from the counters, because the question a
     * reader asks of an evidence package is "is there anything here nobody could account for", and that
     * has to come from the rows themselves.
     */
    const recoveryRows = await this.db
      .select({
        writeState: migrationRecordMaps.writeState,
        note: migrationRecordMaps.reconcileNote,
        n: count(),
      })
      .from(migrationRecordMaps)
      .where(eq(migrationRecordMaps.runId, runId))
      .groupBy(migrationRecordMaps.writeState, migrationRecordMaps.reconcileNote);
    let unresolved = 0;
    let awaiting = 0;
    let byHand = 0;
    let automatically = 0;
    for (const r of recoveryRows) {
      const n = Number(r.n);
      if (r.writeState === 'RECONCILIATION_REQUIRED') awaiting += n;
      if (r.writeState && ['INTENDED', 'UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(r.writeState)) {
        unresolved += n;
      }
      // A note beginning "Resolved by" was written by a person; anything else by reconciliation.
      if (r.note?.startsWith('Resolved by ')) byHand += n;
      else if (r.note) automatically += n;
    }
    const recovery: EvidenceRecoverySummary = {
      unresolved,
      reconciledAutomatically: automatically,
      reconciledByHand: byHand,
      awaitingReconciliation: awaiting,
      note:
        unresolved === 0 && automatically === 0 && byHand === 0
          ? 'Nothing in this run was left in doubt, and nothing needed recovering. That is a statement about this run, not evidence that the recovery protocol works.'
          : `${automatically} record(s) were reconciled against the target automatically and ${byHand} by a person. ${unresolved} remain unresolved. Every one of them is listed in the lineage files with its state and the reason.`,
    };

    return { run, report, plan, entries, targetNames, attempt: row?.attempt ?? 1, recovery };
  }

  /** The manifest, from files that have already been hashed. */
  private manifestFor(
    prepared: {
      run: Awaited<ReturnType<MigrationRunService['get']>>;
      attempt: number;
      recovery: EvidenceRecoverySummary;
    },
    hashed: { path: string; bytes: number; sha256: string }[],
    lineage: EvidenceLineageSummary | null,
    describes: Map<string, string>,
  ): EvidenceManifest {
    const { run } = prepared;
    const rowsOf = (path: string) => (lineage ? lineage.rowsPerFile[lineage.files.indexOf(path)] : undefined);
    const files: EvidenceFileRecord[] = hashed.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      sha256: f.sha256,
      describes: describes.get(f.path) ?? 'No description recorded.',
      ...(rowsOf(f.path) === undefined ? {} : { rows: rowsOf(f.path) }),
    }));
    return {
      evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      // Which build wrote this, because the package outlives the deployment and the question gets asked.
      producedBy: (() => {
        const identity = buildIdentity(this.config);
        return { version: identity.version, commit: identity.commit, deployment: identity.deployment };
      })(),
      run: {
        id: run.id,
        planName: run.planName,
        projectName: null,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        attempt: prepared.attempt,
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
      ...(lineage ? { lineage } : {}),
      recovery: prepared.recovery,
      integrity: {
        algorithm: 'sha256',
        proves: INTEGRITY_PROVES,
        doesNotProve: INTEGRITY_DOES_NOT_PROVE,
      },
    };
  }

  /**
   * The package as one buffer.
   *
   * Kept for callers that need the bytes in hand — a test, and anything that wants to hash the whole
   * archive. It streams underneath, so there is one writer and one lineage implementation; the only
   * difference is that this one waits and concatenates.
   */
  async bundleForRun(ctx: RequestContext, runId: string): Promise<EvidenceBundle> {
    const streamed = await this.streamBundleForRun(ctx, runId);
    const parts: Buffer[] = [];
    for await (const piece of streamed.output) parts.push(piece as Buffer);
    return {
      filename: streamed.filename,
      zip: Buffer.concat(parts),
      manifest: await streamed.manifest,
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

function summaryMarkdown(run: MigrationRunDto, report: ValidationRunDto | null, build: string): string {
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
    `**Produced by** ${build}`,
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
    /**
     * The row this table was missing, and the reason the line above it used to be arithmetically wrong.
     *
     * `processed` counts unresolved records — something was attempted and the answer was lost — so a
     * five-row table claiming to sum to it did not add up on exactly the runs where the numbers matter
     * most. A sign-off document that cannot be reconciled is worse than none.
     */
    `| Unresolved | ${run.unresolved} | Attempted, and the platform cannot prove whether the write landed. **Neither in nor out of the target as far as this evidence goes.** |`,
    `| **Processed** | **${run.processed}** | The six above, added up. |`,
    `| **Written by this run** | **${written}** | Created plus updated. Nothing else. |`,
    ``,
  ];

  /**
   * Said once, plainly, near the top, when there is anything to say.
   *
   * "What remains unresolved" is one of the questions a sign-off has to answer, and a number in a table
   * is not an answer — somebody signing needs to know that the run is not finished with and what the next
   * action is.
   */
  if (run.unresolved > 0) {
    lines.push(
      `> ## ${run.unresolved} record(s) remain unresolved`,
      `>`,
      `> The platform attempted a write and could not establish whether it landed. These records are not`,
      `> counted as migrated and not counted as failed, because neither would be true.`,
      `>`,
      `> **This run is not complete.** Open it in the platform, reconcile the records it names, and`,
      `> re-generate this package. \`lineage/\` lists every one of them with the evidence available for`,
      `> each — see the \`Write state\` and \`Recovery evidence\` columns.`,
      ``,
    );
  }

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
    /**
     * How to check it without us.
     *
     * An auditor's whole position is that they do not take the operator's word for anything, and a
     * package whose only verifier is the vendor's own endpoint asks them to take ours. These are
     * standard tools on every platform, and a reader who uses them needs nothing from this product.
     */
    `### Checking this yourself, without this product`,
    ``,
    `Every digest here is a plain SHA-256 of the file's bytes. You do not need the platform to check`,
    `them:`,
    ``,
    '```',
    `# macOS and Linux`,
    `shasum -a 256 metrics.csv`,
    ``,
    `# Windows PowerShell`,
    `Get-FileHash metrics.csv -Algorithm SHA256`,
    '```',
    ``,
    `Compare the result against the \`sha256\` field for that path in \`manifest.json\`. The platform's`,
    `own check at **Evidence → Verify a package** does the same comparison for every file at once and`,
    `tells you which, if any, disagree — but it is a convenience, not the authority. The arithmetic is`,
    `the authority, and you can do it.`,
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
