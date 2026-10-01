import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { get } from '../lib/api';
import { Callout, Spinner } from './ui';

interface DemoStatus {
  building: boolean;
  ready: boolean;
}

/**
 * Says that the worked examples are on their way.
 *
 * Each evaluator now gets their own workspace, and its two example migrations are built by actually
 * running them — which takes a few seconds. Somebody arriving during those seconds used to meet a
 * projects page with one project on it, or none, and no reason given. That is the only moment the
 * product looks broken while working exactly as designed, and a sentence fixes it.
 *
 * Polls only while there is something to wait for, and stops as soon as the workspace is ready.
 */
export function DemoWorkspaceBuilding({ onReady }: { onReady?: () => void }) {
  const status = useQuery({
    queryKey: ['demo-status'],
    queryFn: () => get<DemoStatus>('/api/demo/status'),
    // Nothing to poll once it is ready; a workspace is only built once.
    refetchInterval: (q) => (q.state.data && !q.state.data.ready ? 2000 : false),
    // A deployment that is not in demo mode answers "ready" and this never renders.
    retry: false,
  });

  const ready = status.data?.ready ?? true;
  useEffect(() => {
    if (ready && status.data) onReady?.();
    // `onReady` is a refetch; re-running it when the identity of the callback changes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  if (!status.data || status.data.ready) return null;
  return (
    <div data-testid="demo-building">
      <Callout tone="info" title="Setting up your workspace">
        <div className="mt-1 flex items-center gap-3">
          <Spinner label="" />
          <span>
            The two worked examples are being migrated now — a clean one and one with real problems in the
            data. They are run, not loaded, which is why it takes a moment. This page updates itself.
          </span>
        </div>
      </Callout>
    </div>
  );
}
