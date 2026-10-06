import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import type { MigrationRunDto, RetrySafetyDto } from '@shared/domain';
import { Button, Card, ErrorState } from './ui';
import { get, post } from '../lib/api';

/**
 * Whether to run this again, answered before the button is offered.
 *
 * A retry is the one action in this product that can put a second copy of a customer's record in their
 * target. "Press it and find out" is not an acceptable interaction for that, so the assessment comes first:
 * what the next attempt would act on, what it would leave alone, and — where repeating a write could
 * duplicate a record — no button at all.
 *
 * The assessment is the server's own decision, read back. The gate in `MigrationRunService.control` refuses
 * an unsafe retry whatever this page shows; this is that decision reported rather than a second copy of it,
 * which is why a page served from a stale cache cannot offer something the server would refuse.
 */
export function RetryControl({ run }: { run: MigrationRunDto }) {
  const qc = useQueryClient();
  const safety = useQuery({
    queryKey: ['retry-safety', run.id, run.status, run.attempt, run.processed],
    queryFn: () => get<RetrySafetyDto>(`/api/runs/${run.id}/retry-safety`),
  });
  const retry = useMutation({
    mutationFn: () => post(`/api/runs/${run.id}/retry`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run', run.id] }),
  });

  if (safety.isLoading) return null;
  if (safety.error)
    return (
      <Card className="mb-5">
        <ErrorState error={safety.error} />
      </Card>
    );
  const s = safety.data!;
  // Nothing is waiting for another attempt. No control, and no sentence about safety either: a run that
  // carried everything is not a run somebody is deciding whether to retry.
  if (s.state === 'NOTHING_TO_RETRY') return null;

  return (
    <Card className="mb-5" data-testid="retry-control">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Next attempt</p>
          <p className="mt-0.5 text-sm text-slate-900" data-testid="retry-reason">
            {s.reason}
          </p>

          {/*
            Exactly what would be left alone, and why. A retry that said "re-runs the failures" and then
            silently skipped a third of them would be the same defect as a run reporting a clean result.
          */}
          {s.excluded.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-slate-600" data-testid="retry-excluded">
              {s.excluded.map((e) => (
                <li key={e.reason}>
                  <span className="font-medium tabular-nums text-slate-900">
                    {e.records.toLocaleString()}
                  </span>{' '}
                  excluded: {e.reason}
                </li>
              ))}
            </ul>
          )}

          {s.state === 'SAFE_TO_RETRY' && (
            <p className="mt-2 text-xs text-slate-500">
              The source is read again from the start. Records already written are matched, never written a
              second time.{' '}
              {/*
                The thing somebody has to know before choosing between this and a new run. A run keeps the
                datasets, mapping and options it started with — deliberately, so a migration stays
                reproducible and a plan edit cannot rewrite what an earlier run did. It also means a
                further attempt cannot carry a reference whose dataset is not in this run: adding the
                dataset and starting a new migration is what does that.
              */}
              This attempt uses the datasets and mapping this run started with. A dataset added to the
              migration since then is carried by a new run, not by this one.
            </p>
          )}
        </div>

        <div className="shrink-0">
          {/*
            The button follows `allowed` and nothing else. There is no disabled retry button here: a
            disabled control invites somebody to look for the way to enable it, and in the one state where
            that matters -- a record that may be in the target with nothing to identify it -- the way
            forward is reconciliation, not a retry.
          */}
          {s.allowed ? (
            <Button
              variant="primary"
              icon={<RotateCw className="h-4 w-4" />}
              loading={retry.isPending}
              onClick={() => retry.mutate()}
              data-testid="retry-run"
            >
              {`Run attempt ${s.attempt + 1} on ${s.safe.toLocaleString()} records`}
            </Button>
          ) : s.state === 'RECONCILE_FIRST' ? (
            <Link
              to={`/runs/${run.id}?tab=reconciliation`}
              className="inline-block rounded-md bg-brand-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-800"
              data-testid="open-reconciliation"
            >
              {`Reconcile ${s.needsReconciliation.toLocaleString()} records`}
            </Link>
          ) : null}
        </div>
      </div>

      {retry.error && (
        <div className="mt-3">
          <ErrorState error={retry.error} />
        </div>
      )}
    </Card>
  );
}
