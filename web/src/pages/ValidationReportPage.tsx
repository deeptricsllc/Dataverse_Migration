import type {
  DifferenceType,
  ValidationDifferenceDto,
  ValidationRunDto,
  ValidationSummary,
} from '@shared/domain';
import { accountedFor, METRIC_DEFINITIONS, writtenByRun, type RecordAccounting } from '@shared/run-metrics';
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
  const clean = s.missingRecords === 0 && s.differentRecords === 0 && s.brokenReferences === 0;
  const tone = outcome === 'FAIL' ? 'danger' : outcome === 'WARNING' ? 'warning' : 'success';

  const lines: ReactNode[] = [];
  lines.push(
    <>
      <strong>{fmtNumber(checked)}</strong> record(s) were checked across{' '}
      <strong>{fmtNumber(s.tablesValidated)}</strong> table(s), comparing the target against the source rather
      than re-reading the migration&apos;s own work.
    </>,
  );
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
        and are not there — they did not migrate
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
  if (clean && checked > 0) {
    lines.push(<>Nothing is missing, nothing differs, and every reference resolves.</>);
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
 * What the run did with every record it touched, in the five buckets that do not overlap.
 *
 * On the report rather than only on the run page, because this is the screen somebody reads to
 * decide whether the migration worked, and "28 records verified" means something very different
 * depending on whether this run put them there.
 */
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

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
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
              hint="Expected in the target, not found"
              onClick={() => {
                setType('MISSING_IN_TARGET');
                setPage(0);
              }}
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
                  <Th className="text-right">Different</Th>
                  <Th className="text-right">Broken refs</Th>
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
                        <Td className={`text-right tabular-nums ${e.different ? 'text-amber-700' : ''}`}>
                          {fmtNumber(e.different)}
                        </Td>
                        <Td className={`text-right tabular-nums ${e.brokenReferences ? 'text-red-700' : ''}`}>
                          {fmtNumber(e.brokenReferences)}
                        </Td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={10} className="bg-slate-50/70 px-6 py-3">
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
