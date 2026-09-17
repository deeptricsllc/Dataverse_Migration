import type { DashboardDto } from '@shared/domain';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, GitCompareArrows, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { WorkspaceHeader } from '../components/Layout';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../components/ui';
import { get } from '../lib/api';
import { fmtNumber, fmtRelative } from '../lib/format';
import { useSession, useWorkspace } from '../lib/session';

export function DashboardPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const { ready } = useWorkspace();
  const q = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => get<DashboardDto>('/api/dashboard'),
    refetchInterval: 10_000,
  });

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.displayName.split(' ')[0]}`}
        description="Overview of your environments, migrations and validations."
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
      <div className="mb-6 rounded-lg border border-slate-200 bg-slate-100/70 p-3">
        <WorkspaceHeader />
      </div>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat
              label="Environments"
              value={q.data.environments.total}
              hint={`${q.data.environments.connected} connected`}
              onClick={() => navigate('/environments')}
            />
            <Stat
              label="Migration runs"
              value={q.data.migrationRuns.total}
              hint={q.data.migrationRuns.active ? `${q.data.migrationRuns.active} active` : 'none active'}
              onClick={() => navigate('/runs')}
            />
            <Stat
              label="Succeeded"
              tone="green"
              value={q.data.migrationRuns.completed}
              hint={`${q.data.migrationRuns.withErrors} with errors`}
            />
            <Stat
              label="Failed runs"
              tone={q.data.migrationRuns.failed ? 'red' : 'default'}
              value={q.data.migrationRuns.failed}
            />
            <Stat
              label="Validations"
              value={q.data.validationRuns.total}
              hint={`${q.data.validationRuns.pass} pass · ${q.data.validationRuns.warning} warn · ${q.data.validationRuns.fail} fail`}
              onClick={() => navigate('/validation')}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card
              className="lg:col-span-2"
              title="Recent migration runs"
              actions={
                <Link to="/runs" className="text-xs font-medium text-brand-700 hover:underline">
                  View all
                </Link>
              }
              bodyClassName="p-0"
            >
              {q.data.recentMigrationRuns.length === 0 ? (
                <EmptyState
                  title="No migration runs yet"
                  description="Select a source and target, analyze them and build a migration plan."
                  action={
                    <Button variant="primary" onClick={() => navigate('/migration/new')}>
                      Start a migration
                    </Button>
                  }
                />
              ) : (
                <Table>
                  <thead className="bg-slate-50">
                    <tr>
                      <Th>Plan</Th>
                      <Th>Source → Target</Th>
                      <Th>Status</Th>
                      <Th className="text-right">Processed</Th>
                      <Th>Started</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {q.data.recentMigrationRuns.map((r) => (
                      <tr
                        key={r.id}
                        className="cursor-pointer hover:bg-slate-50"
                        onClick={() => navigate(`/runs/${r.id}`)}
                      >
                        <Td className="font-medium text-slate-900">{r.planName}</Td>
                        <Td>
                          {r.sourceEnvironment.displayName} <ArrowRight className="inline h-3 w-3" />{' '}
                          {r.targetEnvironment.displayName}
                        </Td>
                        <Td>
                          <StatusBadge status={r.status} />
                        </Td>
                        <Td className="text-right tabular-nums">
                          {fmtNumber(r.processed)} / {fmtNumber(r.total)}
                          {r.failed > 0 && <span className="ml-1 text-red-600">({r.failed} failed)</span>}
                        </Td>
                        <Td className="text-slate-500">{fmtRelative(r.createdAt)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <div className="space-y-6">
              <Card title="Last environment comparison">
                {q.data.lastComparison ? (
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">
                        {q.data.lastComparison.sourceEnvironment.displayName} →{' '}
                        {q.data.lastComparison.targetEnvironment.displayName}
                      </span>
                      <StatusBadge status={q.data.lastComparison.status} />
                    </div>
                    {q.data.lastComparison.summary && (
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <MiniStat label="Match" value={q.data.lastComparison.summary.match} />
                        <MiniStat
                          label="Different"
                          value={
                            q.data.lastComparison.summary.different +
                            q.data.lastComparison.summary.incompatible
                          }
                        />
                        <MiniStat label="Missing" value={q.data.lastComparison.summary.sourceOnly} />
                      </div>
                    )}
                    <Link
                      to={`/compare/${q.data.lastComparison.id}`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                    >
                      Open comparison <ArrowRight className="h-3 w-3" />
                    </Link>
                  </div>
                ) : (
                  <EmptyState
                    icon={<GitCompareArrows className="h-6 w-6" />}
                    title="No comparisons yet"
                    action={<Button onClick={() => navigate('/compare')}>Analyze environments</Button>}
                  />
                )}
              </Card>
              <Card title="Recent validations" bodyClassName="p-0">
                {q.data.recentValidationRuns.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-slate-500">No validation runs yet.</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {q.data.recentValidationRuns.map((v) => (
                      <li key={v.id}>
                        <Link
                          to={`/validation/${v.id}`}
                          className="flex items-center justify-between px-5 py-2.5 text-sm hover:bg-slate-50"
                        >
                          <span className="truncate text-slate-700">
                            {v.sourceEnvironment.displayName} → {v.targetEnvironment.displayName}
                            <span className="block text-xs text-slate-500">{fmtRelative(v.createdAt)}</span>
                          </span>
                          <StatusBadge status={v.outcome ?? v.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-slate-50 py-2">
      <div className="text-lg font-semibold tabular-nums text-slate-900">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}
