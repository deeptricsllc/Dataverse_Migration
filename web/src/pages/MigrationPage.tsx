import type { PlanStatus } from '@shared/domain';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus, Truck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../components/ui';
import { get } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { useWorkspace } from '../lib/session';

interface PlanListItem {
  id: string;
  name: string;
  status: PlanStatus;
  sourceEnvironment: { displayName: string };
  targetEnvironment: { displayName: string };
  tableCount: number;
  blockerCount: number;
  warningCount: number;
  updatedAt: string;
  createdBy: string | null;
}

export function MigrationPage() {
  const navigate = useNavigate();
  const { ready } = useWorkspace();
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => get<PlanListItem[]>('/api/plans') });
  return (
    <>
      <PageHeader
        title="Migration plans"
        description="Plans capture the selected tables, dependency order, field mappings, execution options and every issue found before anything is written."
        actions={
          <Button
            variant="primary"
            icon={<Plus className="h-4 w-4" />}
            onClick={() => navigate(ready ? '/migration/new' : '/environments')}
          >
            New Migration
          </Button>
        }
      />
      <Card bodyClassName="p-0">
        {plans.isLoading && <Spinner />}
        {plans.error && (
          <div className="p-4">
            <ErrorState error={plans.error} onRetry={() => plans.refetch()} />
          </div>
        )}
        {plans.data?.length === 0 && (
          <EmptyState
            icon={<Truck className="h-8 w-8" />}
            title="No migration plans yet"
            description="Start by selecting environments, analyzing them and choosing tables."
            action={
              <Button variant="primary" onClick={() => navigate(ready ? '/migration/new' : '/environments')}>
                New Migration
              </Button>
            }
          />
        )}
        {plans.data && plans.data.length > 0 && (
          <Table>
            <thead className="bg-slate-50">
              <tr>
                <Th>Plan</Th>
                <Th>Source → Target</Th>
                <Th>Status</Th>
                <Th className="text-right">Tables</Th>
                <Th>Issues</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {plans.data.map((p) => (
                <tr
                  key={p.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => navigate(`/migration/plans/${p.id}`)}
                >
                  <Td className="font-medium text-slate-900">{p.name}</Td>
                  <Td>
                    {p.sourceEnvironment.displayName} <ArrowRight className="inline h-3 w-3" />{' '}
                    {p.targetEnvironment.displayName}
                  </Td>
                  <Td>
                    <StatusBadge status={p.status} />
                  </Td>
                  <Td className="text-right tabular-nums">{p.tableCount}</Td>
                  <Td className="space-x-1">
                    {p.blockerCount > 0 && (
                      <StatusBadge status="BLOCKER" label={`${p.blockerCount} blocker(s)`} />
                    )}
                    {p.warningCount > 0 && (
                      <StatusBadge status="WARNING" label={`${p.warningCount} warning(s)`} />
                    )}
                    {p.blockerCount === 0 && p.warningCount === 0 && (
                      <span className="text-xs text-slate-400">None</span>
                    )}
                  </Td>
                  <Td className="text-slate-500">
                    {fmtRelative(p.updatedAt)}
                    {p.createdBy && <span className="block text-xs">by {p.createdBy}</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
