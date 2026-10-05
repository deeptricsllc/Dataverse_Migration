import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { MigrationRunDto, RunFailureSummaryDto } from '@shared/domain';
import { Button, Callout, Card, ErrorState, Pill, Spinner, cx } from './ui';
import { api } from '../lib/api';
import { fmtDate, fmtDuration } from '../lib/format';

/**
 * What happened, in the first viewport.
 *
 * A run page that opens on a progress bar and a log answers "is it still going". The question after a
 * migration is "what happened", and the answer is four numbers, a time, and the one thing to do next.
 * Everything else on the page is evidence for those.
 */
export function RunOutcome({
  run,
  onReviewFailures,
}: {
  run: MigrationRunDto;
  onReviewFailures: () => void;
}) {
  const succeeded = run.created + run.updated + run.unchanged;
  const active = run.status === 'RUNNING' || run.status === 'QUEUED' || run.status === 'PAUSED';
  const next = nextAction(run);

  return (
    <Card className="mb-5" data-testid="run-outcome">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Result</p>
          <p
            className={cx(
              'text-2xl font-semibold',
              run.status === 'FAILED'
                ? 'text-red-700'
                : run.status === 'COMPLETED_WITH_ERRORS' || run.status === 'NEEDS_RECONCILIATION'
                  ? 'text-amber-800'
                  : run.status === 'COMPLETED'
                    ? 'text-emerald-700'
                    : 'text-slate-900',
            )}
            data-testid="run-result"
          >
            {RUN_STATUS_LABELS[run.status]}
          </p>
          {/* Attempt is part of the result: a retry is a further attempt of this run, not a new one. */}
          <p className="mt-0.5 text-sm text-slate-500">
            Attempt {run.attempt} · started {fmtDate(run.startedAt)} · {active ? 'elapsed' : 'duration'}{' '}
            {fmtDuration(run.startedAt, run.completedAt)}
          </p>
        </div>

        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm" data-testid="run-counts">
          <Count label="Attempted" value={run.total} />
          <Count label="Succeeded" value={succeeded} />
          <Count label="Failed" value={run.failed} tone={run.failed > 0 ? 'red' : undefined} />
          <Count label="Skipped" value={run.skipped} />
          {/*
            Unresolved is not failed. The engine could not confirm what the target did with these records,
            and saying either "succeeded" or "failed" would assert something unknown.
          */}
          <Count label="Unresolved" value={run.unresolved} tone={run.unresolved > 0 ? 'amber' : undefined} />
          {run.warningCount > 0 && (
            <Count label="Written with warnings" value={run.warningCount} tone="amber" />
          )}
        </dl>
      </div>

      {next && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Next action</p>
            <p className="text-sm text-slate-900">{next.label}</p>
          </div>
          {next.kind === 'REVIEW_FAILURES' && (
            <Button variant="primary" onClick={onReviewFailures} data-testid="review-failures">
              Review failures
            </Button>
          )}
          {next.kind === 'RECONCILE' && (
            <Button variant="primary" onClick={onReviewFailures} data-testid="review-unresolved">
              Review unresolved records
            </Button>
          )}
          {next.kind === 'VALIDATE' && (
            <Link
              to={`/validation`}
              className="rounded-md bg-brand-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-800"
            >
              Validate run
            </Link>
          )}
        </div>
      )}
    </Card>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: 'red' | 'amber' }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd
        className={cx(
          'text-lg font-semibold tabular-nums',
          tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-800' : 'text-slate-900',
        )}
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

/** One action, from what the run actually reported. Null while there is nothing to do but wait. */
function nextAction(run: MigrationRunDto): { kind: string; label: string } | null {
  if (run.status === 'RUNNING' || run.status === 'QUEUED') return null;
  if (run.failed > 0) {
    return { kind: 'REVIEW_FAILURES', label: `Review ${run.failed.toLocaleString()} failed records.` };
  }
  if (run.unresolved > 0) {
    return {
      kind: 'RECONCILE',
      label: `Reconcile ${run.unresolved.toLocaleString()} records with an unconfirmed result.`,
    };
  }
  if (run.status === 'COMPLETED') {
    return { kind: 'VALIDATE', label: 'Validate the run against the source.' };
  }
  return null;
}

export const RUN_STATUS_LABELS: Record<MigrationRunDto['status'], string> = {
  DRAFT: 'Draft',
  PLANNED: 'Planned',
  QUEUED: 'Queued',
  RUNNING: 'Running',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  COMPLETED_WITH_ERRORS: 'Completed with issues',
  NEEDS_RECONCILIATION: 'Reconciliation required',
  FAILED: 'Failed',
  CANCELLED: 'Canceled',
};

/**
 * Where the failures are, and what caused them.
 *
 * Grouped by dataset and by the code the engine recorded, worst first. A flat list of eighteen thousand
 * errors answers "which records failed" and nothing else; this answers "what went wrong", which is the
 * question that decides what to fix.
 *
 * Nothing here is inferred. A code this product does not define is shown as itself, with the message the
 * target returned, because a connector's own code is what somebody searches for in its documentation.
 */
export function RunFailures({
  run,
  onOpenRecords,
}: {
  run: MigrationRunDto;
  onOpenRecords: (entity: string) => void;
}) {
  const summary = useQuery({
    queryKey: ['run-failures', run.id, run.failed, run.unresolved, run.status],
    queryFn: () => api<RunFailureSummaryDto>('GET', `/api/runs/${run.id}/failures`),
  });

  if (summary.isLoading) return <Spinner label="Reading the failures…" />;
  if (summary.error) return <ErrorState error={summary.error} />;
  const data = summary.data!;
  const withFailures = data.datasets.filter(
    (d) => d.categories.length > 0 || d.warnings.length > 0 || d.unresolved > 0,
  );

  return (
    <Card
      title="Results by dataset"
      subtitle="Failures are grouped by the code the engine recorded. Counts are per attempt."
      data-testid="run-failures"
      bodyClassName="p-0"
    >
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs text-slate-500">
          <tr>
            <th className="px-4 py-2 font-medium">Dataset</th>
            <th className="px-4 py-2 text-right font-medium">Attempted</th>
            <th className="px-4 py-2 text-right font-medium">Succeeded</th>
            <th className="px-4 py-2 text-right font-medium">Failed</th>
            <th className="px-4 py-2 text-right font-medium">Unresolved</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {data.datasets.map((d) => (
            <tr key={d.logicalName} className="border-t border-slate-100" data-testid="dataset-result-row">
              <td className="px-4 py-2 font-medium text-slate-900">{d.displayName}</td>
              <td className="px-4 py-2 text-right tabular-nums">{d.attempted.toLocaleString()}</td>
              <td className="px-4 py-2 text-right tabular-nums">{d.succeeded.toLocaleString()}</td>
              <td
                className={cx(
                  'px-4 py-2 text-right tabular-nums',
                  d.failed > 0 && 'font-semibold text-red-700',
                )}
              >
                {d.failed.toLocaleString()}
              </td>
              <td
                className={cx(
                  'px-4 py-2 text-right tabular-nums',
                  d.unresolved > 0 && 'font-semibold text-amber-800',
                )}
              >
                {d.unresolved.toLocaleString()}
              </td>
              <td className="px-4 py-2 text-right">
                {(d.failed > 0 || d.unresolved > 0) && (
                  <Button size="sm" variant="ghost" onClick={() => onOpenRecords(d.logicalName)}>
                    Records
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {withFailures.length > 0 && (
        <div className="space-y-5 border-t border-slate-200 p-4">
          <div className="flex flex-wrap gap-2 text-xs">
            <Pill tone="slate">{data.retryable.toLocaleString()} retryable</Pill>
            {data.warnings > 0 && (
              <Pill tone="amber">{data.warnings.toLocaleString()} recorded warnings</Pill>
            )}
            <Pill tone="slate">{data.permanent.toLocaleString()} permanent</Pill>
          </div>
          {withFailures.map((d) => (
            <section key={d.logicalName} data-testid="failure-dataset">
              <h4 className="text-sm font-semibold text-slate-900">
                {d.displayName} — {d.failed.toLocaleString()} failed
                {d.warnings.length > 0 && (
                  <span className="font-normal text-amber-800">
                    {' · '}
                    {d.warnings.reduce((n, w) => n + w.records, 0).toLocaleString()} written with warnings
                  </span>
                )}
              </h4>
              <ul className="mt-2 space-y-3">
                {d.categories.map((c) => (
                  <li
                    key={`${c.code}:${c.field ?? ''}`}
                    className="rounded-md border border-slate-200 p-3"
                    data-testid="failure-category"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium text-slate-900">{c.label}</p>
                      <p className="text-sm tabular-nums text-slate-700">
                        {c.records.toLocaleString()} records
                      </p>
                    </div>
                    {c.meaning && <p className="mt-0.5 text-sm text-slate-600">{c.meaning}</p>}
                    {!c.known && c.exampleMessage && (
                      // The product did not define this code, so the target's own message is the evidence.
                      <p className="mt-0.5 text-sm text-slate-600">{c.exampleMessage}</p>
                    )}
                    {c.action && <p className="mt-0.5 text-sm text-brand-800">{c.action}</p>}
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="font-mono">{c.code}</span>
                      {c.field && <span className="font-mono">field: {c.field}</span>}
                      <Pill tone={c.retryable ? 'blue' : 'slate'}>
                        {c.retryable ? 'Retryable' : 'Permanent'}
                      </Pill>
                    </p>
                  </li>
                ))}
              </ul>
              {/*
                Written, with something the run could not carry across. Separate from failures because
                these records are in the target: a reader deciding what to fix needs to know which of the
                two they are looking at.
              */}
              {d.warnings.length > 0 && (
                <ul className="mt-2 space-y-2">
                  {d.warnings.map((w) => (
                    <li
                      key={`w:${w.code}:${w.field ?? ''}`}
                      className="rounded-md border border-amber-200 bg-amber-50 p-3"
                      data-testid="failure-warning"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-sm font-medium text-amber-900">{w.label}</p>
                        <p className="text-sm tabular-nums text-amber-900">
                          {w.records.toLocaleString()} records
                        </p>
                      </div>
                      {w.meaning && <p className="mt-0.5 text-sm text-amber-900">{w.meaning}</p>}
                      {!w.known && w.exampleMessage && (
                        <p className="mt-0.5 text-sm text-amber-900">{w.exampleMessage}</p>
                      )}
                      {w.action && <p className="mt-0.5 text-sm text-amber-900">{w.action}</p>}
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-amber-800">
                        <span className="font-mono">{w.code}</span>
                        {w.field && <span className="font-mono">field: {w.field}</span>}
                        <span>The record was written.</span>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {d.unresolved > 0 && (
                <Callout tone="warning" title={`${d.unresolved.toLocaleString()} records are unresolved`}>
                  The target accepted the request. The final write result is not confirmed. These records are
                  not failures, and retrying them without reconciliation can create duplicates.
                </Callout>
              )}
            </section>
          ))}
        </div>
      )}

      {withFailures.length === 0 && (
        <p className="border-t border-slate-200 p-4 text-sm text-slate-600">
          No failed records and no warnings in this run.
        </p>
      )}
    </Card>
  );
}
