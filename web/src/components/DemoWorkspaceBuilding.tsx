import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { DemoSetupStatusDto } from '@shared/domain';
import { get, post } from '../lib/api';
import { Button, Callout, ErrorState, Spinner } from './ui';

/**
 * What the demo workspace is doing, including when it has stopped.
 *
 * Each evaluator gets their own workspace, and its two example migrations are built by actually running
 * them, which takes a few seconds. Somebody arriving during those seconds used to meet a projects page
 * with nothing on it and no reason given — the one moment the product looks broken while working exactly
 * as designed.
 *
 * It had a worse sibling. When setup gave up, this went on saying the workspace was being prepared, for
 * ever, because the only thing it knew was "not ready" and it read that as "still going". The workspace
 * never filled in, nothing was retrying, and nothing said so. The two states are now distinct and the
 * failed one offers the way out.
 */
export function DemoWorkspaceBuilding({ onReady }: { onReady?: () => void }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['demo-status'],
    queryFn: () => get<DemoSetupStatusDto>('/api/demo/status'),
    /*
     * Poll while something is happening, and stop when it is not. A workspace that has failed is not
     * going to change on its own, so polling it would be asking a question nobody is answering.
     */
    refetchInterval: (q) => (q.state.data && q.state.data.status === 'BUILDING' ? 2000 : false),
    // A deployment that is not in demo mode answers ready and this never renders.
    retry: false,
  });

  const retry = useMutation({
    mutationFn: () => post<DemoSetupStatusDto>('/api/demo/retry-setup', {}),
    onSuccess: (next) => {
      qc.setQueryData(['demo-status'], next);
      if (next.ready) onReady?.();
    },
  });

  const ready = status.data?.ready ?? true;
  useEffect(() => {
    if (ready && status.data) onReady?.();
    // `onReady` is a refetch; re-running it when the identity of the callback changes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  if (!status.data || status.data.ready) return null;

  if (status.data.status === 'FAILED') {
    return (
      <div data-testid="demo-setup-failed">
        <Callout tone="warning" title="Demo workspace unavailable">
          <p>Setup did not complete. The worked examples are not in this workspace.</p>
          {/* What the server recorded, kept as it recorded it. */}
          <p className="mt-1 text-xs text-slate-600" data-testid="demo-setup-detail">
            {status.data.detail}
          </p>
          <div className="mt-3">
            <Button
              variant="primary"
              loading={retry.isPending}
              onClick={() => retry.mutate()}
              data-testid="retry-demo-setup"
            >
              Retry setup
            </Button>
          </div>
          {retry.error && (
            <div className="mt-3">
              <ErrorState error={retry.error} />
            </div>
          )}
        </Callout>
      </div>
    );
  }

  return (
    <div data-testid="demo-building">
      <Callout tone="info" title="Preparing demo workspace">
        <div className="mt-1 flex items-center gap-3">
          <Spinner label="" />
          <span>
            Demo data is being prepared. The two worked examples are migrated now — a clean one, and one with
            real problems in the data. They are run, not loaded, which is why it takes a moment. This page
            updates itself.
          </span>
        </div>
      </Callout>
    </div>
  );
}
