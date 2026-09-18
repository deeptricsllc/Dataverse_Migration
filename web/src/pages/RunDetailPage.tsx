import type {
  MigrationErrorDto,
  MigrationRunDto,
  RecordMapDto,
  RollbackPreviewDto,
  ValidationRunDto,
} from '@shared/domain';
import { TERMINAL_RUN_STATUSES } from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Ban, Pause, Play, RotateCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { WizardSteps } from '../components/WizardSteps';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Modal,
  Mono,
  PageHeader,
  Pill,
  ProgressBar,
  Select,
  ExportButton,
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Tabs,
  Td,
  Th,
} from '../components/ui';
import { get, post, qs } from '../lib/api';
import { fmtDate, fmtDuration, fmtNumber, pct } from '../lib/format';

type Tab = 'progress' | 'errors' | 'records' | 'rollback';
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
  const entitiesDone = r.entities.filter((e) =>
    ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(e.status),
  ).length;

  return (
    <>
      <WizardSteps
        current={terminal ? 8 : 7}
        links={{
          6: `/migration/plans/${r.planId}?step=review`,
          ...(r.latestValidationRunId ? { 9: `/validation/${r.latestValidationRunId}` } : {}),
        }}
      />
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
            {['COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'].includes(r.status) && (
              <Button
                icon={<RotateCw className="h-4 w-4" />}
                loading={control.isPending && control.variables === 'retry'}
                onClick={() => control.mutate('retry')}
              >
                {r.status === 'CANCELLED' ? 'Resume remaining work' : 'Retry failed records'}
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
          <span className="w-14 text-right text-lg font-semibold tabular-nums" data-testid="overall-percent">
            {overall}%
          </span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <Stat label="Tables" value={`${entitiesDone}/${r.entities.length}`} />
          <Stat label="Processed" value={fmtNumber(r.processed)} hint={`of ${fmtNumber(r.total)}`} />
          <Stat label="Created" tone="green" value={fmtNumber(r.created)} />
          <Stat label="Updated" tone="blue" value={fmtNumber(r.updated)} />
          <Stat
            label="Unchanged"
            tone="slate"
            value={fmtNumber(r.unchanged)}
            hint={r.options.conflictStrategy === 'SYNC' ? 'identical in target' : undefined}
          />
          <Stat label="Skipped" tone="slate" value={fmtNumber(r.skipped)} />
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
            { value: 'errors', label: `Errors (${r.errorCount + r.warningCount})` },
            { value: 'records', label: 'Record inventory' },
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
      {tab === 'errors' && <ErrorsPanel run={r} />}
      {tab === 'records' && <RecordsPanel run={r} />}
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

function ErrorsPanel({ run }: { run: MigrationRunDto }) {
  const [kind, setKind] = useState<'all' | 'retryable' | 'permanent'>('all');
  const [entity, setEntity] = useState('');
  const [severity, setSeverity] = useState<'' | 'ERROR' | 'WARNING'>('');
  const [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ['run-errors', run.id, kind, entity, severity, page, run.processed, run.status],
    queryFn: () =>
      get<{ items: MigrationErrorDto[]; total: number }>(
        `/api/runs/${run.id}/errors${qs({ kind, entity: entity || undefined, severity: severity || undefined, limit: PAGE, offset: page * PAGE })}`,
      ),
  });
  return (
    <Card
      title="Record errors and warnings"
      subtitle="Failures are isolated per record; the run continues. Retryable errors (throttling, transient or unresolved references) may succeed on retry."
      actions={
        <>
          <Select
            label="Error kind"
            value={kind}
            onChange={(v) => {
              setKind(v as typeof kind);
              setPage(0);
            }}
            options={[
              { value: 'all', label: 'All' },
              { value: 'retryable', label: 'Retryable' },
              { value: 'permanent', label: 'Permanent' },
            ]}
          />
          <Select
            label="Severity"
            value={severity}
            onChange={(v) => {
              setSeverity(v as typeof severity);
              setPage(0);
            }}
            options={[
              { value: '', label: 'Errors & warnings' },
              { value: 'ERROR', label: 'Errors' },
              { value: 'WARNING', label: 'Warnings' },
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
            href={`/api/runs/${run.id}/errors.csv${qs({ kind, entity: entity || undefined, severity: severity || undefined })}`}
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
      {q.data && q.data.total === 0 && (
        <EmptyState title="No errors" description="Nothing matches these filters." />
      )}
      {q.data && q.data.total > 0 && (
        <>
          <Table>
            <thead className="bg-slate-50">
              <tr>
                <Th>Table</Th>
                <Th>Source record</Th>
                <Th>Operation</Th>
                <Th>Code</Th>
                <Th>Message</Th>
                <Th>Type</Th>
                <Th>Time</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {q.data.items.map((e) => (
                <tr key={e.id} data-testid="run-error-row">
                  <Td>{e.entity}</Td>
                  <Td>
                    <Mono>{e.sourceRecordId ?? '—'}</Mono>
                  </Td>
                  <Td className="text-xs">
                    {e.operation}
                    {e.field && <div className="text-slate-500">field {e.field}</div>}
                  </Td>
                  <Td>
                    <Mono>{e.errorCode}</Mono>
                  </Td>
                  <Td className="max-w-md text-xs">{e.message}</Td>
                  <Td className="space-y-1">
                    <StatusBadge status={e.severity} />
                    <div>{e.retryable ? <Pill tone="blue">retryable</Pill> : <Pill>permanent</Pill>}</div>
                    {e.attempts > 1 && (
                      <div className="text-[11px] text-slate-500">{e.attempts} attempts</div>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-slate-500">{fmtDate(e.createdAt)}</Td>
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

export function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-600">
      <span>
        {fmtNumber(page * PAGE + 1)}–{fmtNumber(Math.min(total, (page + 1) * PAGE))} of {fmtNumber(total)}
      </span>
      <span className="flex gap-2">
        <Button size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </span>
    </div>
  );
}
