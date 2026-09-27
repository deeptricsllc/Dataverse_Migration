import type { AccessRequestDto } from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { Button, Card, ErrorState, EmptyState, Pill, Spinner, Table, Td, Th } from './ui';
import { patch, get } from '../lib/api';
import { fmtDate } from '../lib/format';

/**
 * Inbound requests from the landing page.
 *
 * Only rendered for a platform operator — someone named in ADMIN_EMAILS — because these are not any
 * one organization's data. A customer administrator seeing them would be reading the names and
 * email addresses of other people who asked for access.
 */
export function AccessRequestsCard() {
  const qc = useQueryClient();
  const requests = useQuery({
    queryKey: ['access-requests'],
    queryFn: () => get<AccessRequestDto[]>('/api/access-requests'),
  });
  const setHandled = useMutation({
    mutationFn: ({ id, handled }: { id: string; handled: boolean }) =>
      patch(`/api/access-requests/${id}`, { handled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access-requests'] }),
  });

  const open = requests.data?.filter((r) => !r.handledAt).length ?? 0;

  return (
    <Card
      title="Access requests"
      subtitle="People who asked for access from the public landing page. Visible to the operators of this deployment only."
      actions={open > 0 ? <Pill tone="amber">{open} waiting</Pill> : undefined}
      bodyClassName="p-0"
    >
      {requests.isLoading && <Spinner />}
      {requests.error && (
        <div className="p-4">
          <ErrorState error={requests.error} onRetry={() => requests.refetch()} />
        </div>
      )}
      {requests.data?.length === 0 && (
        <EmptyState title="Nothing yet" description="Requests submitted from the landing page appear here." />
      )}
      {requests.data && requests.data.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Who</Th>
              <Th>What they are moving</Th>
              <Th>Asked</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {requests.data.map((r) => (
              <tr key={r.id} className={r.handledAt ? 'opacity-50' : undefined}>
                <Td>
                  <div className="font-medium text-slate-900">{r.name}</div>
                  <a
                    href={`mailto:${r.email}`}
                    className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
                  >
                    <Mail className="h-3 w-3" aria-hidden />
                    {r.email}
                  </a>
                  {r.company && <div className="text-xs text-slate-500">{r.company}</div>}
                </Td>
                <Td className="max-w-md whitespace-pre-wrap text-sm text-slate-600">{r.useCase ?? '—'}</Td>
                <Td className="whitespace-nowrap text-xs text-slate-500">
                  {fmtDate(r.createdAt)}
                  {r.submissions > 1 && <Pill tone="amber">asked {r.submissions}×</Pill>}
                  {r.handledAt && <div className="mt-1">Handled by {r.handledBy}</div>}
                </Td>
                <Td className="whitespace-nowrap">
                  <Button
                    size="sm"
                    loading={setHandled.isPending}
                    onClick={() => setHandled.mutate({ id: r.id, handled: !r.handledAt })}
                  >
                    {r.handledAt ? 'Reopen' : 'Mark handled'}
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
