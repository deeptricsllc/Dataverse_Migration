import { AGGREGATE_CAVEAT, type AggregateCheck } from '@shared/aggregates';
import type {
  DifferenceType,
  ValidationDifferenceDto,
  ValidationRunDto,
  ValidationSummary,
} from '@shared/domain';
import { accountedFor, METRIC_DEFINITIONS, writtenByRun, type RecordAccounting } from '@shared/run-metrics';
import {
  coveragePercent,
  describeClean,
  VALIDATION_DEPTHS,
  type ValidationCoverage,
} from '@shared/validation-coverage';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Callout,
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  Mono,
  PageHeader,
  Pill,
  Select,
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../components/ui';
import { get, qs } from '../lib/api';
import { fmtDate, fmtNumber, humanize } from '../lib/format';
import { Pager } from './RunDetailPage';

const PAGE = 50;

const OUTCOME_LABELS: Record<string, string> = {
  PASS: 'All checks passed',
  WARNING: 'Passed with warnings',
  FAIL: 'Checks failed',
};

/**
 * What the report means, in words, before any table of numbers.
 *
 * The tiles are accurate and were being misread: "source rows 30, target rows 144" invites the
 * conclusion that something went badly wrong, when it only means the target already held data. A
 * report that has to be interpreted correctly to be useful is a report that will be interpreted
 * incorrectly, so the plain reading goes first and the numbers back it up.
 */
function Verdict({
  summary,
  outcome,
  migrationRunId,
}: {
  summary: ValidationSummary;
  outcome: string | null;
  migrationRunId: string | null;
}) {
  const s = summary;
  const checked = s.matchedRecords + s.missingRecords + s.differentRecords;
  // A run that did not deliver records is not a clean result, whatever the reason it gives.
  const clean =
    s.missingRecords === 0 &&
    s.failedInRunRecords === 0 &&
    s.differentRecords === 0 &&
    s.brokenReferences === 0;
  const tone = outcome === 'FAIL' ? 'danger' : outcome === 'WARNING' ? 'warning' : 'success';

  const lines: ReactNode[] = [];
  lines.push(
    <>
      <strong>{fmtNumber(checked)}</strong> record(s) were checked across{' '}
      <strong>{fmtNumber(s.tablesValidated)}</strong> table(s), comparing the target against the source rather
      than re-reading the migration&apos;s own work.
    </>,
  );
  // What a clean result is allowed to say, derived from how much was examined. "All checks passed"
  // over a sample is the sentence this exists to prevent.
  if (clean && s.coverage) {
    lines.push(<>{describeClean(s.coverage)}</>);
  }
  if (s.matchedRecords > 0) {
    lines.push(
      <>
        <strong className="text-emerald-700">{fmtNumber(s.matchedRecords)}</strong> match the source on every
        field that was compared.
      </>,
    );
  }
  if (s.missingRecords > 0) {
    lines.push(
      <>
        <strong className="text-red-700">{fmtNumber(s.missingRecords)}</strong> were expected in the target
        and are not there, although the run did not report a failure for them. That is this report&apos;s own
        finding
        {migrationRunId ? (
          <>
            {' '}
            (
            <Link to={`/runs/${migrationRunId}`} className="font-medium text-brand-700 hover:underline">
              see the run
            </Link>
            )
          </>
        ) : null}
        .
      </>,
    );
  }
  if (s.failedInRunRecords > 0) {
    // The run already said these failed. Confirming it is useful; counting it as a validation
    // miss is not, and adding the two made matched + missing + differing exceed the number of
    // records examined.
    lines.push(
      <>
        <strong className="text-red-700">{fmtNumber(s.failedInRunRecords)}</strong> were reported as failed by
        the run itself and are confirmed absent. They were never compared, because there is nothing in the
        target to compare them against
        {migrationRunId ? (
          <>
            {' '}
            (
            <Link to={`/runs/${migrationRunId}`} className="font-medium text-brand-700 hover:underline">
              see the run for why
            </Link>
            )
          </>
        ) : null}
        .
      </>,
    );
  }
  if (s.differentRecords > 0) {
    lines.push(
      <>
        <strong className="text-amber-700">{fmtNumber(s.differentRecords)}</strong> exist on both sides but
        hold a different value in at least one field. Each one is listed below.
      </>,
    );
  }
  if (s.brokenReferences > 0) {
    lines.push(
      <>
        <strong className="text-red-700">{fmtNumber(s.brokenReferences)}</strong> lookup value(s) point at a
        record that does not exist in the target.
      </>,
    );
  }
  if (clean && checked > 0 && s.coverage?.mode === 'FULL') {
    lines.push(<>Nothing is missing, nothing differs, and every reference resolves.</>);
  }
  if (s.duplicateRecords > 0) {
    lines.push(
      <>
        <strong className="text-amber-700">{fmtNumber(s.duplicateRecords)}</strong> record(s) share a key
        value that should identify one record. They are listed by table below.
      </>,
    );
  }
  if (s.targetRows > s.sourceRows) {
    lines.push(
      <>
        The target holds <strong>{fmtNumber(s.targetRows)}</strong> row(s) against the source&apos;s{' '}
        <strong>{fmtNumber(s.sourceRows)}</strong>. That is expected: it already contained data before this
        migration, and validation only checks the records this run was responsible for.
      </>,
    );
  }
  // Checking a record and writing it are different things, and a report that only gives the first
  // number invites the reader to assume the run wrote everything it verified.
  if (s.accounting) {
    const written = writtenByRun(s.accounting);
    const alreadyThere = s.accounting.unchanged + s.accounting.skipped;
    lines.push(
      written === 0 && alreadyThere > 0 ? (
        <>
          This run wrote <strong>nothing</strong>: all <strong>{fmtNumber(alreadyThere)}</strong> record(s) it
          accounted for were already in the target and were left as they were. What is verified below is the
          state of that existing data, not work this run did.
        </>
      ) : (
        <>
          <strong>{fmtNumber(written)}</strong> record(s) were written by this run (
          {fmtNumber(s.accounting.created)} created, {fmtNumber(s.accounting.updated)} updated)
          {alreadyThere > 0 ? (
            <>
              ; <strong>{fmtNumber(alreadyThere)}</strong> were already in the target and left alone
            </>
          ) : null}
          .
        </>
      ),
    );
  }

  // Callout takes no test id of its own, and a wrapper is cheaper than widening its props.
  return (
    <div data-testid="validation-verdict">
      <Callout tone={tone} title={outcome ? (OUTCOME_LABELS[outcome] ?? outcome) : 'Validation complete'}>
        <ul className="space-y-1.5">
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}

/**
 * How much of the data this report is actually about.
 *
 * Given its own panel rather than a footnote, because it qualifies every other number on the page.
 * The three states are never styled alike: a sample that found nothing and a check that could not
 * run are both "no failures found" and neither is "it is correct".
 */
function CoveragePanel({ coverage, depth }: { coverage: ValidationCoverage | null; depth: string | null }) {
  if (!coverage) {
    return (
      <Callout tone="info" title="Coverage was not recorded for this report">
        This report predates coverage being recorded, so how much of the data it examined is not known. Re-run
        the validation to find out.
      </Callout>
    );
  }
  const tone = coverage.mode === 'FULL' ? 'success' : coverage.mode === 'SAMPLED' ? 'warning' : 'info';
  const title =
    coverage.mode === 'FULL'
      ? 'Full validation'
      : coverage.mode === 'SAMPLED'
        ? `Sampled validation — ${coveragePercent(coverage)}% of eligible records`
        : 'Not fully verified';
  const depthMeta = depth ? VALIDATION_DEPTHS[depth as keyof typeof VALIDATION_DEPTHS] : null;
  return (
    <div data-testid="validation-coverage">
      <Callout tone={tone} title={title}>
        <dl className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-500">Eligible records</dt>
            <dd className="font-medium tabular-nums">{fmtNumber(coverage.eligible)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Examined</dt>
            <dd className="font-medium tabular-nums">{fmtNumber(coverage.examined)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Coverage</dt>
            <dd className="font-medium tabular-nums">{coveragePercent(coverage)}%</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Depth</dt>
            <dd className="font-medium">{depthMeta?.label ?? '—'}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs">
          {coverage.strategy}
          {coverage.cap !== null && ` Capped at ${fmtNumber(coverage.cap)} records per table.`}
        </p>
        {coverage.mode === 'SAMPLED' && (
          <p className="mt-1 text-xs">
            Nothing is claimed about the {fmtNumber(coverage.eligible - coverage.examined)} record(s) that
            were not examined. Run a full validation to cover them.
          </p>
        )}
        {coverage.reason && <p className="mt-1 text-xs">{coverage.reason}</p>}
      </Callout>
    </div>
  );
}

/**
 * What the run did with every record it touched, in the five buckets that do not overlap.
 *
 * On the report rather than only on the run page, because this is the screen somebody reads to
 * decide whether the migration worked, and "28 records verified" means something very different
 * depending on whether this run put them there.
 */
/**
 * Totals compared across the two sides.
 *
 * Shown with its scope attached to every row, because this is the one panel in the report somebody
 * will quote out of context. A SUM that agrees is worth reading; a SUM that agrees over a target
 * holding records this run never wrote is worth nothing, and the only thing separating the two is
 * the sentence next to the number. The caveat sits under the table in the same type as the numbers,
 * not in a tooltip.
 */
function AggregatePanel({ aggregates, entity }: { aggregates: AggregateCheck[]; entity: string }) {
  if (aggregates.length === 0) return null;
  const unverified = aggregates.filter((a) => a.outcome === 'NOT_VERIFIED');
  return (
    <div className="mt-3" data-testid={`aggregates-${entity}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Totals compared</p>
      {aggregates.length === unverified.length ? (
        // Nothing was compared. Saying which figure was unavailable and why beats an empty table
        // that reads as "no problems found".
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          No totals could be compared. {unverified[0]!.reason} {unverified[0]!.scope}
        </p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {aggregates.map((a) => (
            <li key={`${a.kind}-${a.column ?? 'rows'}`} className="flex flex-wrap items-baseline gap-2">
              <span className="w-28 flex-none text-xs font-semibold uppercase tracking-wide text-slate-500">
                {a.kind}
                {a.column ? ` · ${a.column}` : ''}
              </span>
              {a.outcome === 'NOT_VERIFIED' ? (
                <Pill tone="slate" title={a.reason}>
                  not verified
                </Pill>
              ) : (
                <>
                  <Mono className="text-xs">{a.sourceValue ?? '—'}</Mono>
                  <ArrowRight className="h-3 w-3 text-slate-400" aria-hidden />
                  <Mono className={`text-xs ${a.outcome === 'FAIL' ? 'text-red-700' : ''}`}>
                    {a.targetValue ?? '—'}
                  </Mono>
                  {a.outcome === 'FAIL' && <Pill tone="red">differs</Pill>}
                </>
              )}
              <span className="text-xs text-slate-400">{a.scope}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 max-w-3xl text-xs text-slate-500">{AGGREGATE_CAVEAT}</p>
    </div>
  );
}

function RunAccounting({
  accounting,
  migrationRunId,
}: {
  accounting: RecordAccounting | null;
  migrationRunId: string | null;
}) {
  if (!migrationRunId) return null;
  if (!accounting) {
    return (
      <Callout tone="info" title="Per-record accounting was not recorded for this report">
        This report predates the breakdown of what the run created, updated or left alone. Re-run the
        validation to get it. The figures above are unaffected.
      </Callout>
    );
  }
  const written = writtenByRun(accounting);
  const buckets = [
    { key: 'created', value: accounting.created, tone: 'green' as const },
    { key: 'updated', value: accounting.updated, tone: 'green' as const },
    { key: 'unchanged', value: accounting.unchanged, tone: 'default' as const },
    { key: 'skipped', value: accounting.skipped, tone: 'default' as const },
    {
      key: 'failed',
      value: accounting.failed,
      tone: accounting.failed ? ('red' as const) : ('default' as const),
    },
  ];
  return (
    <Card
      title="What this run did with each record"
      subtitle={`${fmtNumber(accountedFor(accounting))} record(s) accounted for · ${fmtNumber(written)} written by this run`}
      data-testid="run-accounting"
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {buckets.map((b) => {
          const meta = METRIC_DEFINITIONS[b.key as keyof typeof METRIC_DEFINITIONS];
          return (
            <Stat
              key={b.key}
              label={meta.label}
              tone={b.tone}
              value={fmtNumber(b.value)}
              hint={meta.definition}
            />
          );
        })}
      </div>
    </Card>
  );
}

export function ValidationReportPage() {
  const { validationId } = useParams();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [entity, setEntity] = useState('');
  const [type, setType] = useState('');
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(0);
  const run = useQuery({
    queryKey: ['validation', validationId],
    queryFn: () => get<ValidationRunDto>(`/api/validations/${validationId}`),
    refetchInterval: (q) =>
      q.state.data && ['QUEUED', 'RUNNING'].includes(q.state.data.status) ? 1000 : false,
  });
  const done = run.data?.status === 'COMPLETED';
  const diffs = useQuery({
    queryKey: ['validation-diffs', validationId, entity, type, outcome, page],
    queryFn: () =>
      get<{ items: ValidationDifferenceDto[]; total: number }>(
        `/api/validations/${validationId}/differences${qs({ entity: entity || undefined, type: type || undefined, outcome: outcome || undefined, limit: PAGE, offset: page * PAGE })}`,
      ),
    enabled: done,
  });

  if (run.isLoading) return <Spinner label="Loading validation…" />;
  if (run.error || !run.data) return <ErrorState error={run.error ?? new Error('Validation not found')} />;
  const v = run.data;
  const s = v.summary;

  return (
    <>
      <PageHeader
        title="Validation report"
        description={
          <>
            <span className="text-[var(--color-source)]">{v.sourceEnvironment.displayName}</span>{' '}
            <ArrowRight className="inline h-3.5 w-3.5" />{' '}
            <span className="text-[var(--color-target)]">{v.targetEnvironment.displayName}</span> ·{' '}
            {fmtDate(v.createdAt)}
            {v.createdBy && ` · by ${v.createdBy}`}
            {v.migrationRunId && (
              <>
                {' '}
                ·{' '}
                <Link to={`/runs/${v.migrationRunId}`} className="font-medium text-brand-700 hover:underline">
                  migration run
                </Link>
              </>
            )}
          </>
        }
        actions={
          /*
            One badge, not two. "Completed" and "Fail" side by side read as a contradiction: the
            first is the state of the job, the second the verdict on the data, and nobody should
            have to know that to read the page. While it is running the state is the news; once it
            has finished, the verdict is.
          */
          done && v.outcome ? (
            <StatusBadge status={v.outcome} label={OUTCOME_LABELS[v.outcome]} className="text-sm" />
          ) : (
            <StatusBadge status={v.status} />
          )
        }
      />
      {['QUEUED', 'RUNNING'].includes(v.status) && (
        <Card>
          <div className="flex items-center gap-3 text-sm text-slate-600">
            <StatusBadge status={v.status} /> {v.progressMessage}
          </div>
        </Card>
      )}
      {v.status === 'FAILED' && <ErrorState error={new Error(`Validation failed: ${v.errorMessage}`)} />}

      {done && s && (
        <div className="space-y-5">
          <Verdict summary={s} outcome={v.outcome} migrationRunId={v.migrationRunId} />

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-9">
            <Stat
              label="Tables"
              value={s.tablesValidated}
              hint={`${s.pass} pass · ${s.warning} warn · ${s.fail} fail`}
            />
            <Stat label="Source rows" value={fmtNumber(s.sourceRows)} hint="In the source tables" />
            <Stat
              label="Target rows"
              value={fmtNumber(s.targetRows)}
              hint={
                s.targetRows > s.sourceRows ? 'Includes records that were already there' : 'In the target'
              }
            />
            <Stat
              label={METRIC_DEFINITIONS.written.label}
              value={s.accounting ? fmtNumber(writtenByRun(s.accounting)) : '—'}
              hint={
                s.accounting
                  ? 'Created + updated. Records already in the target are counted below.'
                  : 'Not recorded for this report'
              }
            />
            <Stat
              label="Matched"
              tone="green"
              value={fmtNumber(s.matchedRecords)}
              hint="Identical on both sides"
            />
            <Stat
              label="Missing"
              tone={s.missingRecords ? 'red' : 'default'}
              value={fmtNumber(s.missingRecords)}
              hint="Expected in the target, not found, and the run did not say so"
              onClick={() => {
                setType('MISSING_IN_TARGET');
                setPage(0);
              }}
            />
            <Stat
              label="Failed in the run"
              tone={s.failedInRunRecords ? 'red' : 'default'}
              value={fmtNumber(s.failedInRunRecords)}
              hint="The run reported these; confirmed absent, never compared"
            />
            <Stat
              label="Different"
              tone={s.differentRecords ? 'amber' : 'default'}
              value={fmtNumber(s.differentRecords)}
              hint="Present, but a field value differs"
              onClick={() => {
                setType('VALUE_MISMATCH');
                setPage(0);
              }}
            />
            <Stat
              label="Broken refs"
              tone={s.brokenReferences ? 'red' : 'default'}
              value={fmtNumber(s.brokenReferences)}
              hint="Lookups pointing at a record that is not there"
              onClick={() => {
                setType('BROKEN_REFERENCE');
                setPage(0);
              }}
            />
          </div>

          <CoveragePanel coverage={s.coverage} depth={v.depth} />

          <RunAccounting accounting={s.accounting} migrationRunId={v.migrationRunId} />

          <Card
            title="Results by table"
            actions={<ExportButton href={`/api/validations/${v.id}/summary.csv`} label="Export summary" />}
            bodyClassName="p-0"
          >
            <Table>
              <thead className="bg-slate-50">
                <tr>
                  <Th className="w-8" />
                  <Th>Table</Th>
                  <Th>Outcome</Th>
                  <Th className="text-right">Source</Th>
                  <Th className="text-right">Target</Th>
                  <Th className="text-right">Checked</Th>
                  <Th className="text-right">Matched</Th>
                  <Th className="text-right">Missing</Th>
                  <Th className="text-right">Failed in run</Th>
                  <Th className="text-right">Different</Th>
                  <Th className="text-right">Broken refs</Th>
                  <Th className="text-right">Duplicates</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {v.entities.map((e) => {
                  const open = expanded === e.logicalName;
                  return (
                    <Fragment key={e.logicalName}>
                      <tr
                        className="cursor-pointer hover:bg-slate-50"
                        onClick={() => setExpanded(open ? null : e.logicalName)}
                        data-testid={`validation-entity-${e.logicalName}`}
                      >
                        <Td>
                          {open ? (
                            <ChevronDown className="h-4 w-4 text-slate-400" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-slate-400" />
                          )}
                        </Td>
                        <Td>
                          <div className="font-medium text-slate-900">{e.displayName}</div>
                          <Mono>{e.logicalName}</Mono>
                        </Td>
                        <Td>
                          <StatusBadge status={e.outcome} />
                        </Td>
                        <Td className="text-right tabular-nums">{fmtNumber(e.sourceCount)}</Td>
                        <Td className="text-right tabular-nums">{fmtNumber(e.targetCount)}</Td>
                        <Td className="text-right tabular-nums">{fmtNumber(e.checkedRecords)}</Td>
                        <Td className="text-right tabular-nums">{fmtNumber(e.matched)}</Td>
                        <Td className={`text-right tabular-nums ${e.missing ? 'text-red-700' : ''}`}>
                          {fmtNumber(e.missing)}
                        </Td>
                        <Td className={`text-right tabular-nums ${e.failedInRun ? 'text-red-700' : ''}`}>
                          {fmtNumber(e.failedInRun)}
                        </Td>
                        <Td className={`text-right tabular-nums ${e.different ? 'text-amber-700' : ''}`}>
                          {fmtNumber(e.different)}
                        </Td>
                        <Td className={`text-right tabular-nums ${e.brokenReferences ? 'text-red-700' : ''}`}>
                          {fmtNumber(e.brokenReferences)}
                        </Td>
                        {/*
                          A dash is not a zero here. "No duplicates" and "we could not look for
                          duplicates" are different answers, and the column that shows one must not
                          be read as the other.
                        */}
                        <Td className="text-right tabular-nums">
                          {e.duplicateCoverage?.mode === 'NOT_VERIFIED' ? (
                            <span
                              className="text-xs font-medium text-slate-400"
                              title={e.duplicateCoverage.reason}
                            >
                              not verified
                            </span>
                          ) : (
                            <span className={(e.duplicates?.length ?? 0) > 0 ? 'text-amber-700' : ''}>
                              {fmtNumber((e.duplicates ?? []).reduce((n, d) => n + d.occurrences, 0))}
                            </span>
                          )}
                        </Td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={12} className="bg-slate-50/70 px-6 py-3">
                            <ul className="space-y-1.5">
                              {e.checks.map((c) => (
                                <li key={c.check} className="flex items-start gap-3 text-sm">
                                  <StatusBadge status={c.outcome} className="w-20 justify-center" />
                                  <span className="w-40 flex-none text-xs font-semibold uppercase tracking-wide text-slate-500">
                                    {humanize(c.check)}
                                  </span>
                                  <span className="text-slate-700">{c.message}</span>
                                </li>
                              ))}
                            </ul>
                            {e.duplicates && e.duplicates.length > 0 && (
                              <div className="mt-3" data-testid={`duplicates-${e.logicalName}`}>
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                  Repeated {e.duplicates[0]!.columns.join(' + ')}
                                </p>
                                <ul className="mt-1 space-y-1 text-sm">
                                  {e.duplicates.slice(0, 10).map((d) => (
                                    <li key={d.value} className="flex flex-wrap items-baseline gap-2">
                                      <Mono className="text-xs">{d.value}</Mono>
                                      <span className="text-slate-600">
                                        {fmtNumber(d.occurrences)} records
                                      </span>
                                      {d.attributable === true && (
                                        <Pill tone="amber">this run wrote {d.writtenByThisRun} of them</Pill>
                                      )}
                                      {d.attributable === false && (
                                        <Pill tone="slate">already in the target</Pill>
                                      )}
                                      {d.attributable === null && (
                                        <Pill
                                          tone="slate"
                                          title="Too many records to attribute from a sample"
                                        >
                                          origin unknown
                                        </Pill>
                                      )}
                                      <span className="text-xs text-slate-400">
                                        e.g. {d.sampleIds.slice(0, 3).join(', ')}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                {e.duplicates.length > 10 && (
                                  <p className="mt-1 text-xs text-slate-500">
                                    and {e.duplicates.length - 10} more repeated value(s)
                                  </p>
                                )}
                              </div>
                            )}
                            {e.aggregates && (
                              <AggregatePanel aggregates={e.aggregates} entity={e.logicalName} />
                            )}
                            <button
                              type="button"
                              className="mt-2 text-xs font-medium text-brand-700 underline"
                              onClick={() => {
                                setEntity(e.logicalName);
                                setType('');
                                setPage(0);
                                document
                                  .getElementById('differences')
                                  ?.scrollIntoView({ behavior: 'smooth' });
                              }}
                            >
                              Inspect differences for {e.displayName}
                            </button>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </Card>

          <div id="differences">
            <Card
              title="Differences"
              subtitle="Values are normalized before comparison; secured columns are masked and long values truncated."
              actions={
                <>
                  <Select
                    label="Table"
                    value={entity}
                    onChange={(x) => {
                      setEntity(x);
                      setPage(0);
                    }}
                    options={[
                      { value: '', label: 'All tables' },
                      ...v.entities.map((e) => ({ value: e.logicalName, label: e.displayName })),
                    ]}
                  />
                  <Select
                    label="Difference type"
                    value={type}
                    onChange={(x) => {
                      setType(x);
                      setPage(0);
                    }}
                    options={[
                      { value: '', label: 'All types' },
                      ...(
                        [
                          'MISSING_IN_TARGET',
                          'VALUE_LOST',
                          'VALUE_TRUNCATED',
                          'VALUE_MISMATCH',
                          'LOOKUP_MISMATCH',
                          'BROKEN_REFERENCE',
                          'PRE_EXISTING_DIFFERENCE',
                        ] as DifferenceType[]
                      ).map((t) => ({ value: t, label: humanize(t) })),
                    ]}
                  />
                  <Select
                    label="Outcome"
                    value={outcome}
                    onChange={(x) => {
                      setOutcome(x);
                      setPage(0);
                    }}
                    options={[
                      { value: '', label: 'Fail & warning' },
                      { value: 'FAIL', label: 'Fail' },
                      { value: 'WARNING', label: 'Warning' },
                    ]}
                  />
                  <ExportButton
                    href={`/api/validations/${v.id}/differences.csv${qs({
                      entity: entity || undefined,
                      type: type || undefined,
                      outcome: outcome || undefined,
                    })}`}
                    label="Export differences"
                  />
                </>
              }
              bodyClassName="p-0"
            >
              {diffs.isLoading && <Spinner />}
              {diffs.error && (
                <div className="p-4">
                  <ErrorState error={diffs.error} />
                </div>
              )}
              {diffs.data?.total === 0 && (
                <EmptyState title="No differences" description="Nothing matches these filters." />
              )}
              {diffs.data && diffs.data.total > 0 && (
                <>
                  <Table>
                    <thead className="bg-slate-50">
                      <tr>
                        <Th>Table</Th>
                        <Th>Record</Th>
                        <Th>Field</Th>
                        <Th>Source value</Th>
                        <Th>Target value</Th>
                        <Th>Type</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {diffs.data.items.map((d) => (
                        <tr key={d.id} data-testid="difference-row">
                          <Td>{d.entity}</Td>
                          <Td>
                            <Mono>{d.sourceRecordId ?? '—'}</Mono>
                            {d.targetRecordId && d.targetRecordId !== d.sourceRecordId && (
                              <div className="text-[11px] text-slate-500">
                                target <Mono>{d.targetRecordId}</Mono>
                              </div>
                            )}
                          </Td>
                          <Td>
                            <Mono>{d.field ?? '—'}</Mono>
                          </Td>
                          <Td className="max-w-xs break-words text-xs">
                            {d.sourceValue ?? <span className="text-slate-400">empty</span>}
                          </Td>
                          <Td className="max-w-xs break-words text-xs">
                            {d.targetValue ?? <span className="text-slate-400">empty</span>}
                          </Td>
                          <Td className="space-y-1">
                            <StatusBadge status={d.outcome} />
                            <div className="text-[11px] text-slate-500">{humanize(d.differenceType)}</div>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <Pager page={page} total={diffs.data.total} onPage={setPage} />
                </>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
