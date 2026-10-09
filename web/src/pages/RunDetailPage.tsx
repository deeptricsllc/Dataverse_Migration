import type {
  MigrationRunDto,
  RecordMapDto,
  RollbackPreviewDto,
  RunFailureSummaryDto,
  ValidationRunDto,
} from '@shared/domain';
import { TERMINAL_RUN_STATUSES } from '@shared/domain';
import { METRIC_DEFINITIONS, writtenByRun } from '@shared/run-metrics';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Ban, Pause, Play, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  Modal,
  Mono,
  PageHeader,
  Pager,
  Pill,
  ProgressBar,
  Select,
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Tabs,
  Td,
  Th,
} from '../components/ui';
import { RunFailures, RunOutcome } from '../components/RunOutcome';
import { RunFailureList } from '../components/RunFailureList';
import { RetryControl } from '../components/RetryControl';
import { ReconciliationPanel } from '../components/ReconciliationPanel';
import { get, post, qs } from '../lib/api';
import { fmtDate, fmtDuration, fmtNumber, pct } from '../lib/format';

type Tab = 'progress' | 'errors' | 'records' | 'reconciliation' | 'rollback';
const PAGE = 50;

export function RunDetailPage() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('progress');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const run = useQuery({
    queryKey: ['run', runId],
    queryFn: () => get<MigrationRunDto>(`/api/runs/${runId}`),
    refetchInterval: (q) =>
      q.state.data && !TERMINAL_RUN_STATUSES.has(q.state.data.status) && q.state.data.status !== 'PAUSED'
        ? 1000
        : false,
  });
  const control = useMutation({
    mutationFn: (action: 'cancel' | 'pause' | 'resume' | 'retry') =>
      post<MigrationRunDto>(`/api/runs/${runId}/${action}`),
    onSuccess: (data) => {
      qc.setQueryData(['run', runId], data);
      setConfirmCancel(false);
    },
  });
  const validate = useMutation({
    mutationFn: () => post<ValidationRunDto>('/api/validations', { migrationRunId: runId }),
    onSuccess: (v) => navigate(`/validation/${v.id}`),
  });

  if (run.isLoading) return <Spinner label="Loading run…" />;
  if (run.error || !run.data) return <ErrorState error={run.error ?? new Error('Run not found')} />;
  const r = run.data;
  const terminal = TERMINAL_RUN_STATUSES.has(r.status);
  const active = r.status === 'RUNNING' || r.status === 'QUEUED';
  const overall = r.status === 'COMPLETED' ? 100 : pct(r.processed, r.total);
  const written = writtenByRun(r);
  const entitiesDone = r.entities.filter((e) =>
    ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(e.status),
  ).length;

  return (
    <>
      <PageHeader
        title={`Migration run`}
        description={
          <>
            <Link to={`/migration/plans/${r.planId}`} className="font-medium text-brand-700 hover:underline">
              {r.planName}
            </Link>{' '}
            · <span className="text-[var(--color-source)]">{r.sourceEnvironment.displayName}</span>{' '}
            <ArrowRight className="inline h-3.5 w-3.5" />{' '}
            <span className="text-[var(--color-target)]">{r.targetEnvironment.displayName}</span> ·{' '}
            <Mono>{r.id}</Mono>
          </>
        }
        actions={
          <>
            {active && (
              <Button
                icon={<Pause className="h-4 w-4" />}
                loading={control.isPending && control.variables === 'pause'}
                disabled={r.pauseRequested}
                onClick={() => control.mutate('pause')}
              >
                {r.pauseRequested ? 'Pausing…' : 'Pause'}
              </Button>
            )}
            {r.status === 'PAUSED' && (
              <Button
                variant="primary"
                icon={<Play className="h-4 w-4" />}
                loading={control.isPending}
                onClick={() => control.mutate('resume')}
              >
                Resume
              </Button>
            )}
            {(active || r.status === 'PAUSED') && (
              <Button
                variant="danger"
                icon={<Ban className="h-4 w-4" />}
                disabled={r.cancelRequested}
                onClick={() => setConfirmCancel(true)}
              >
                {r.cancelRequested ? 'Cancelling…' : 'Cancel'}
              </Button>
            )}
            {terminal && (
              <Button
                variant="primary"
                icon={<ShieldCheck className="h-4 w-4" />}
                loading={validate.isPending}
                onClick={() => validate.mutate()}
              >
                Validate
              </Button>
            )}
            {/*
              The retainable record of this run. Offered here rather than buried among the CSVs,
              because it is the thing somebody attaches to a change record and reads six months
              later, when the environments have moved on and nothing can be re-run.
            */}
            {terminal && (
              <ExportButton
                href={`/api/runs/${r.id}/evidence.zip`}
                label="Evidence package"
                title="Configuration, record outcomes, validation coverage and connector verification, with a digest for each file."
              />
            )}
          </>
        }
      />
      {control.error && (
        <div className="mb-4">
          <ErrorState error={control.error} />
        </div>
      )}
      {validate.error && (
        <div className="mb-4">
          <ErrorState error={validate.error} />
        </div>
      )}
      {r.errorMessage && (
        <div className="mb-4">
          <Callout tone="danger" title="Run failed">
            {r.errorMessage}
          </Callout>
        </div>
      )}
      {r.latestValidationRunId && (
        <div className="mb-4">
          <Callout tone="info" title="This run has been validated">
            <Link className="font-medium underline" to={`/validation/${r.latestValidationRunId}`}>
              Open the latest validation report
            </Link>
          </Callout>
        </div>
      )}

      {/*
        What happened, before anything else. The page used to open on a progress bar, which answers "is
        it still going" — a question nobody asks about a run that finished an hour ago.
      */}
      <RunOutcome run={r} onReviewFailures={() => setTab('errors')} onValidate={() => validate.mutate()} />
      {/*
        Below the outcome, because the question it answers comes after "what happened". One control, whose
        wording and whose existence both come from the server's own assessment.
      */}
      <RetryControl run={r} />

      {/*
        While it is going, and not afterwards.

        This is the live view: which pass, which table, how far through. Once the run has finished every line
        of it is somewhere better — the result and the attempt are in the card above, and the per-table
        progress is the tab below, where it is a real breakdown rather than one bar at 100%. Leaving it up
        gave a finished run three cards that each restated the attempt and the counts, which is how a reader
        comes to distrust all three.
      */}
      {active && (
        <Card className="mb-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <StatusBadge status={r.status} className="text-sm" />
              <span className="text-sm text-slate-600">
                {r.phase === 'PASS_2_DEFERRED_LOOKUPS'
                  ? 'Pass 2: setting deferred lookups'
                  : r.phase === 'PASS_1'
                    ? 'Pass 1: creating records'
                    : r.phase === 'DONE'
                      ? 'Finished'
                      : 'Waiting for worker'}
                {r.currentEntity && active && (
                  <>
                    {' '}
                    · current table <strong>{r.currentEntity}</strong>
                  </>
                )}
              </span>
            </div>
            <div className="text-sm text-slate-500">
              Attempt {r.attempt} · started {fmtDate(r.startedAt)} · elapsed{' '}
              {fmtDuration(r.startedAt, r.completedAt)}
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <div className="flex-1">
              <ProgressBar
                value={overall}
                tone={
                  r.status === 'FAILED'
                    ? 'red'
                    : r.failed > 0
                      ? 'amber'
                      : r.status === 'COMPLETED'
                        ? 'green'
                        : 'brand'
                }
                label="Overall progress"
              />
            </div>
            <span
              className="w-14 text-right text-lg font-semibold tabular-nums"
              data-testid="overall-percent"
            >
              {overall}%
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="Tables" value={`${entitiesDone}/${r.entities.length}`} />
            <Stat
              label={METRIC_DEFINITIONS.processed.label}
              value={fmtNumber(r.processed)}
              hint={`of ${fmtNumber(r.total)}`}
            />
            {/*
            The figure the validation report leads with, led with here too. The two screens used to
            describe the same run with different arithmetic, so the number that answers "did
            anything actually move" now comes from one place and appears on both.
          */}
            <Stat
              label={METRIC_DEFINITIONS.written.label}
              tone={written ? 'green' : 'slate'}
              value={fmtNumber(written)}
              hint={written ? 'created + updated' : 'nothing was written to the target'}
            />
            <Stat label={METRIC_DEFINITIONS.created.label} tone="green" value={fmtNumber(r.created)} />
            <Stat label={METRIC_DEFINITIONS.updated.label} tone="blue" value={fmtNumber(r.updated)} />
            <Stat
              label={METRIC_DEFINITIONS.unchanged.label}
              tone="slate"
              value={fmtNumber(r.unchanged)}
              hint={r.options.conflictStrategy === 'SYNC' ? 'identical in target' : 'already matched'}
            />
            <Stat
              label={METRIC_DEFINITIONS.skipped.label}
              tone="slate"
              value={fmtNumber(r.skipped)}
              hint={r.skipped ? 'already in the target, left alone' : undefined}
            />
            <Stat
              label="Failed"
              tone={r.failed ? 'red' : 'default'}
              value={fmtNumber(r.failed)}
              onClick={() => setTab('errors')}
            />
            <Stat
              label="Warnings"
              tone={r.warningCount ? 'amber' : 'default'}
              value={fmtNumber(r.warningCount)}
              onClick={() => setTab('errors')}
            />
          </div>
        </Card>
      )}

      {r.transformationMetrics && r.transformationMetrics.valuesTransformed > 0 && (
        <Card
          title="Transformations applied"
          subtitle="What the transformation engine did during this run."
          className="mb-4"
          data-testid="transformation-metrics"
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Stat label="Records" value={fmtNumber(r.transformationMetrics.recordsTransformed)} />
            <Stat label="Values" value={fmtNumber(r.transformationMetrics.valuesTransformed)} />
            <Stat
              label="Lossy"
              tone={r.transformationMetrics.lossyValues ? 'amber' : 'default'}
              value={fmtNumber(r.transformationMetrics.lossyValues)}
              hint="information discarded"
            />
            <Stat label="Defaults" value={fmtNumber(r.transformationMetrics.defaultsApplied)} />
            <Stat label="Null conversions" value={fmtNumber(r.transformationMetrics.nullConversions)} />
            <Stat label="Value maps" value={fmtNumber(r.transformationMetrics.valueMappings)} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            {Object.entries(r.transformationMetrics.byKind)
              .sort((a, b) => b[1] - a[1])
              .map(([kind, count]) => (
                <Pill key={kind} tone="blue">
                  {kind.toLowerCase().replace(/_/g, ' ')} · {fmtNumber(count)}
                </Pill>
              ))}
          </div>
        </Card>
      )}

      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'progress', label: 'Tables' },
            /*
              Named for what is in it. It said `Errors (235)` on a run whose result line said `Failed 0`
              directly above it, because the count has always included warnings — and a reader seeing both
              numbers has to decide which one to believe.
            */
            {
              value: 'errors',
              /*
               * Records, not rows. A retry records its own failures without replacing the earlier ones, so a
               * run of nine records retried once holds eighteen rows — and `Failures (18)` above `Failed 9`
               * asks the reader to decide which number to believe. The rows are all still in the list, each
               * with the attempt that recorded it.
               */
              label:
                r.errorCount > 0 && r.warningCount > 0
                  ? `Failures and warnings (${r.recordsWithProblems})`
                  : r.warningCount > 0
                    ? `Warnings (${r.recordsWithProblems})`
                    : `Failures (${r.recordsWithProblems})`,
            },
            { value: 'records', label: 'Record inventory' },
            /*
             * Offered only when there is something to settle. A permanent tab that is empty on every clean
             * run teaches people to ignore it, and this is the one tab that must be noticed.
             */
            ...(r.unresolved > 0
              ? [{ value: 'reconciliation' as const, label: `Reconcile (${r.unresolved})` }]
              : []),
            { value: 'rollback', label: 'Rollback preview' },
          ]}
        />
      </div>

      {tab === 'progress' && (
        <Card bodyClassName="p-0">
          <Table>
            <thead className="bg-slate-50">
              <tr>
                <Th>#</Th>
                <Th>Table</Th>
                <Th>Status</Th>
                <Th className="w-64">Progress</Th>
                <Th className="text-right">Created</Th>
                <Th className="text-right">Updated</Th>
                <Th className="text-right">Unchanged</Th>
                <Th className="text-right">Skipped</Th>
                <Th className="text-right">Failed</Th>
                <Th>Deferred lookups</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {r.entities.map((e) => {
                const p = e.status === 'COMPLETED' ? 100 : pct(e.processed, e.total);
                return (
                  <tr key={e.id} data-testid={`run-entity-${e.logicalName}`}>
                    <Td className="tabular-nums text-slate-500">{e.orderIndex}</Td>
                    <Td>
                      <div className="font-medium text-slate-900">{e.displayName}</div>
                      <Mono>{e.logicalName}</Mono>
                    </Td>
                    <Td>
                      <StatusBadge status={e.status} />
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <ProgressBar
                          value={p}
                          tone={e.failed ? 'amber' : e.status === 'COMPLETED' ? 'green' : 'brand'}
                          label={`${e.displayName} progress`}
                        />
                        <span className="w-28 flex-none text-right text-xs tabular-nums text-slate-600">
                          {fmtNumber(e.processed)} / {fmtNumber(e.total)} · {p}%
                        </span>
                      </div>
                    </Td>
                    <Td className="text-right tabular-nums">{fmtNumber(e.created)}</Td>
                    <Td className="text-right tabular-nums">{fmtNumber(e.updated)}</Td>
                    <Td className="text-right tabular-nums">{fmtNumber(e.unchanged)}</Td>
                    <Td className="text-right tabular-nums">{fmtNumber(e.skipped)}</Td>
                    <Td className={`text-right tabular-nums ${e.failed ? 'font-semibold text-red-700' : ''}`}>
                      {fmtNumber(e.failed)}
                    </Td>
                    <Td className="text-xs text-slate-600">
                      {e.deferredPending + e.deferredResolved + e.deferredFailed === 0 ? (
                        '—'
                      ) : (
                        <>
                          {e.deferredResolved} resolved
                          {e.deferredPending > 0 && ` · ${e.deferredPending} pending`}
                          {e.deferredFailed > 0 && (
                            <span className="text-red-700"> · {e.deferredFailed} failed</span>
                          )}
                        </>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
      {/*
        Only when there was more than one attempt. On a run that finished first time the breakdown is the
        run's own numbers restated, and a panel that says nothing new teaches people to skip panels.
      */}
      {r.attempt > 1 && <AttemptsPanel run={r} />}
      {/* Where the failures are, grouped by cause, above the flat list of them. */}
      {(r.failed > 0 || r.unresolved > 0 || terminal) && (
        <div className="mb-5">
          <RunFailures run={r} onOpenRecords={() => setTab('records')} />
        </div>
      )}
      {tab === 'errors' && <FailuresTab run={r} />}
      {tab === 'records' && <RecordsPanel run={r} />}
      {tab === 'reconciliation' && <ReconciliationPanel run={r} />}
      {tab === 'rollback' && <RollbackPanel runId={r.id} />}

      <Modal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel migration run?"
        footer={
          <>
            <Button onClick={() => setConfirmCancel(false)}>Keep running</Button>
            <Button variant="danger" loading={control.isPending} onClick={() => control.mutate('cancel')}>
              Cancel run
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          The run stops after the current batch. Records already written to{' '}
          <strong>{r.targetEnvironment.displayName}</strong> stay in place and remain listed in the record
          inventory. You can resume the remaining work later.
        </p>
      </Modal>
    </>
  );
}

/**
 * What each attempt is answerable for.
 *
 * Shown apart from the run's counters, and labelled, because they are different kinds of number: the
 * run's totals are what somebody signs for, and these are execution history. Conflating them is how a
 * reader ends up with a figure larger than the data.
 */
function AttemptsPanel({ run }: { run: MigrationRunDto }) {
  const q = useQuery({
    queryKey: ['run-attempts', run.id, run.attempt, run.processed, run.status],
    queryFn: () =>
      get<{
        attempt: number;
        run: Record<string, number>;
        attempts: {
          attempt: number | null;
          recordsWithProblems: number | null;
          created: number;
          updated: number;
          unchanged: number;
          skipped: number;
          failed: number;
          unresolved: number;
          firstRecordAt: string;
          lastRecordAt: string;
        }[];
        someRecordsPredateAttemptTracking: boolean;
        means: string;
      }>(`/api/runs/${run.id}/attempts`),
  });
  if (q.isLoading) return null;
  if (q.error || !q.data) return null;
  const { attempts, means, someRecordsPredateAttemptTracking } = q.data;

  return (
    <Card className="mt-4" data-testid="attempts-panel">
      <div className="px-6 pt-5">
        <h2 className="text-sm font-semibold text-slate-900">What each attempt did</h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">{means}</p>
      </div>
      <Table className="mt-3">
        <thead>
          <tr>
            <Th>Attempt</Th>
            <Th className="text-right">Created</Th>
            <Th className="text-right">Updated</Th>
            <Th className="text-right">Unchanged</Th>
            <Th className="text-right">Skipped</Th>
            <Th className="text-right">Failed</Th>
            <Th className="text-right">Unresolved</Th>
            {/*
              What this attempt recorded at the time, which no later attempt overwrites. It is how an
              attempt whose records have all been redone still appears here rather than reading as though it
              never ran.
            */}
            <Th className="text-right">Problems found</Th>
            <Th>Touched records</Th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a) => (
            <tr key={String(a.attempt)}>
              <Td>
                {a.attempt === null ? (
                  <span
                    className="text-slate-500"
                    title="These records predate the platform recording which attempt touched them."
                  >
                    not recorded
                  </span>
                ) : (
                  <strong>#{a.attempt}</strong>
                )}
              </Td>
              <Td className="text-right tabular-nums">{fmtNumber(a.created)}</Td>
              <Td className="text-right tabular-nums">{fmtNumber(a.updated)}</Td>
              <Td className="text-right tabular-nums">{fmtNumber(a.unchanged)}</Td>
              <Td className="text-right tabular-nums">{fmtNumber(a.skipped)}</Td>
              <Td className={`text-right tabular-nums ${a.failed ? 'text-red-700' : ''}`}>
                {fmtNumber(a.failed)}
              </Td>
              <Td className={`text-right tabular-nums ${a.unresolved ? 'text-amber-700' : ''}`}>
                {fmtNumber(a.unresolved)}
              </Td>
              <Td className="text-right tabular-nums">
                {a.recordsWithProblems === null ? (
                  <span className="text-slate-400">Not recorded</span>
                ) : (
                  fmtNumber(a.recordsWithProblems)
                )}
              </Td>
              <Td className="text-xs text-slate-500">
                {/*
                  Empty for an attempt whose records a later attempt has taken over. Saying so is the point:
                  a date range invented for it would claim the attempt touched nothing.
                */}
                {a.firstRecordAt && a.lastRecordAt ? (
                  <>
                    {fmtDate(a.firstRecordAt)} → {fmtDate(a.lastRecordAt)}
                  </>
                ) : (
                  <span className="text-slate-400">A later attempt redid these records</span>
                )}
              </Td>
            </tr>
          ))}
          {/* The totals, so the two kinds of number can be reconciled without leaving the screen. */}
          <tr className="border-t-2 border-slate-200 bg-slate-50/60">
            <Td>
              <strong>Run total</strong>
            </Td>
            <Td className="text-right tabular-nums font-semibold">{fmtNumber(run.created)}</Td>
            <Td className="text-right tabular-nums font-semibold">{fmtNumber(run.updated)}</Td>
            <Td className="text-right tabular-nums font-semibold">{fmtNumber(run.unchanged)}</Td>
            <Td className="text-right tabular-nums font-semibold">{fmtNumber(run.skipped)}</Td>
            <Td className="text-right tabular-nums font-semibold">{fmtNumber(run.failed)}</Td>
            <Td className="text-right tabular-nums font-semibold">{fmtNumber(run.unresolved)}</Td>
            <Td className="text-xs text-slate-500">every record, counted once</Td>
          </tr>
        </tbody>
      </Table>
      {someRecordsPredateAttemptTracking && (
        <p className="px-6 pb-4 text-xs text-slate-500">
          Some records were migrated before this platform recorded which attempt touched them, so they are
          listed as not recorded rather than assigned to the first attempt.
        </p>
      )}
    </Card>
  );
}

/**
 * The failure list, with the causes this run recorded.
 *
 * The cause filter offers what the summary found rather than every code the product knows, so the list
 * cannot offer a filter that matches nothing.
 */
function FailuresTab({ run }: { run: MigrationRunDto }) {
  const summary = useQuery({
    queryKey: ['run-failures', run.id, run.processed, run.status],
    queryFn: () => get<RunFailureSummaryDto>(`/api/runs/${run.id}/failures`),
  });
  const codes = [
    ...new Set(
      (summary.data?.datasets ?? []).flatMap((d) => [...d.categories, ...d.warnings].map((c) => c.code)),
    ),
  ].sort();
  return <RunFailureList run={run} codes={codes} />;
}

function RecordsPanel({ run }: { run: MigrationRunDto }) {
  const [entity, setEntity] = useState('');
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ['run-records', run.id, entity, outcome, page, run.processed],
    queryFn: () =>
      get<{ items: RecordMapDto[]; total: number }>(
        `/api/runs/${run.id}/records${qs({ entity: entity || undefined, outcome: outcome || undefined, limit: PAGE, offset: page * PAGE })}`,
      ),
  });
  return (
    <Card
      title="Record identity inventory"
      subtitle="Source → target identity for every processed record. Used for lookup resolution, retries, validation and rollback."
      actions={
        <>
          <Select
            label="Outcome"
            value={outcome}
            onChange={(v) => {
              setOutcome(v);
              setPage(0);
            }}
            options={[
              { value: '', label: 'All outcomes' },
              ...['CREATED', 'UPDATED', 'UNCHANGED', 'SKIPPED', 'FAILED'].map((o) => ({
                value: o,
                label: o.toLowerCase(),
              })),
            ]}
          />
          <Select
            label="Table"
            value={entity}
            onChange={(v) => {
              setEntity(v);
              setPage(0);
            }}
            options={[
              { value: '', label: 'All tables' },
              ...run.entities.map((e) => ({ value: e.logicalName, label: e.displayName })),
            ]}
          />
          <ExportButton
            href={`/api/runs/${run.id}/records.csv${qs({ entity: entity || undefined, outcome: outcome || undefined })}`}
          />
        </>
      }
      bodyClassName="p-0"
    >
      {q.isLoading && <Spinner />}
      {q.error && (
        <div className="p-4">
          <ErrorState error={q.error} />
        </div>
      )}
      {q.data && q.data.total === 0 && <EmptyState title="No records" />}
      {q.data && q.data.total > 0 && (
        <>
          <Table>
            <thead className="bg-slate-50">
              <tr>
                <Th>Table</Th>
                <Th>Source ID</Th>
                <Th>Target ID</Th>
                <Th>Outcome</Th>
                <Th>Matched by</Th>
                <Th>Deferred lookups</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {q.data.items.map((m) => (
                <tr key={m.entity + m.sourceId}>
                  <Td>{m.entity}</Td>
                  <Td>
                    <Mono>{m.sourceId}</Mono>
                  </Td>
                  <Td>
                    <Mono>{m.targetId ?? '—'}</Mono>
                  </Td>
                  <Td>
                    <StatusBadge status={m.outcome} />
                  </Td>
                  <Td className="text-xs">{m.matchMethod ?? '—'}</Td>
                  <Td>
                    {m.deferredStatus ? (
                      <StatusBadge status={m.deferredStatus} />
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pager page={page} total={q.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

function RollbackPanel({ runId }: { runId: string }) {
  const q = useQuery({
    queryKey: ['rollback', runId],
    queryFn: () => get<RollbackPreviewDto>(`/api/runs/${runId}/rollback-preview`),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const p = q.data;
  return (
    <Card
      title="Rollback impact preview"
      subtitle="What reverting this run would involve, derived from the record identity inventory."
    >
      <div className="space-y-4">
        <Callout tone="warning" title="Rollback execution: NOT YET SUPPORTED">
          {p.reason}
        </Callout>
        <Table className="rounded-md border border-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Table</Th>
              <Th className="text-right">Created by run (would be deleted)</Th>
              <Th className="text-right">Updated (cannot be restored)</Th>
              <Th className="text-right">Skipped (untouched)</Th>
              <Th className="text-right">Failed (not written)</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {p.entities.map((e) => (
              <tr key={e.entity}>
                <Td>{e.displayName}</Td>
                <Td className="text-right tabular-nums font-medium">{fmtNumber(e.created)}</Td>
                <Td className="text-right tabular-nums">{fmtNumber(e.updated)}</Td>
                <Td className="text-right tabular-nums">{fmtNumber(e.skipped)}</Td>
                <Td className="text-right tabular-nums">{fmtNumber(e.failed)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-sm text-slate-600">
          Deletion order (reverse dependency order): <strong>{p.deletionOrder.join(' → ')}</strong>
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          {p.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
