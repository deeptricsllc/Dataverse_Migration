import type { EnvironmentDto } from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Database, Globe, MapPin, PlugZap, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WizardSteps } from '../components/WizardSteps';
import {
  Button,
  Callout,
  EmptyState,
  ErrorState,
  PageHeader,
  Pill,
  SearchInput,
  Spinner,
  StatusBadge,
  cx,
} from '../components/ui';
import { get, post } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { useSession, useWorkspace } from '../lib/session';

export function EnvironmentsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useSession();
  const workspace = useWorkspace();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');

  const envs = useQuery({
    queryKey: ['environments'],
    queryFn: () => get<EnvironmentDto[]>('/api/environments'),
  });
  const discover = useMutation({
    mutationFn: () => post<EnvironmentDto[]>('/api/environments/discover'),
    onSuccess: (data) => {
      qc.setQueryData(['environments'], data);
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
  });
  const test = useMutation({
    mutationFn: (id: string) => post<EnvironmentDto>(`/api/environments/${id}/test`),
    onSuccess: (env) => {
      qc.setQueryData<EnvironmentDto[]>(['environments'], (old) =>
        old?.map((e) => (e.id === env.id ? env : e)),
      );
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
  });

  // First visit: discover automatically.
  const autoDiscover =
    envs.data && envs.data.length === 0 && !discover.isPending && !discover.isSuccess && !discover.error;
  useEffect(() => {
    if (autoDiscover) discover.mutate();
  }, [autoDiscover]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => envs.data ?? [], [envs.data]);
  const types = useMemo(() => ['ALL', ...new Set(list.map((e) => e.environmentType ?? 'Unknown'))], [list]);
  const filtered = list.filter(
    (e) =>
      (typeFilter === 'ALL' || (e.environmentType ?? 'Unknown') === typeFilter) &&
      `${e.displayName} ${e.url} ${e.uniqueName ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  );

  const select = async (role: 'source' | 'target', env: EnvironmentDto) => {
    const next = {
      sourceEnvironmentId: workspace.source?.id ?? null,
      targetEnvironmentId: workspace.target?.id ?? null,
    };
    if (role === 'source') {
      next.sourceEnvironmentId = env.id;
      if (next.targetEnvironmentId === env.id) next.targetEnvironmentId = null;
    } else {
      next.targetEnvironmentId = env.id;
      if (next.sourceEnvironmentId === env.id) next.sourceEnvironmentId = null;
    }
    await workspace.setWorkspace(next);
  };

  const bothConnected =
    workspace.source?.connectionStatus === 'CONNECTED' && workspace.target?.connectionStatus === 'CONNECTED';

  return (
    <>
      <WizardSteps current={1} />
      <PageHeader
        title="Environments"
        description={
          user.organization.isDemo
            ? 'Simulated Dataverse environments available to the demo account.'
            : 'Dataverse environments your Microsoft account can access, discovered through the Dataverse Global Discovery Service.'
        }
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search environments" />
            <select
              aria-label="Filter by type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded-md border border-slate-300 bg-white py-1.5 pl-2.5 pr-8 text-sm shadow-sm"
            >
              {types.map((t) => (
                <option key={t} value={t}>
                  {t === 'ALL' ? 'All types' : t}
                </option>
              ))}
            </select>
            <Button
              icon={<RefreshCw className="h-4 w-4" />}
              loading={discover.isPending}
              onClick={() => discover.mutate()}
            >
              Refresh environments
            </Button>
          </>
        }
      />

      {workspace.error && (
        <div className="mb-4">
          <ErrorState error={workspace.error} />
        </div>
      )}
      {discover.error && (
        <div className="mb-4">
          <ErrorState error={discover.error} onRetry={() => discover.mutate()} />
        </div>
      )}

      {workspace.ready && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3">
          <div className="text-sm text-brand-900">
            <span className="font-semibold">{workspace.source!.displayName}</span>{' '}
            <ArrowRight className="inline h-3.5 w-3.5" />{' '}
            <span className="font-semibold">{workspace.target!.displayName}</span>
            {!bothConnected && (
              <span className="ml-2 text-brand-800">— test both connections before analyzing.</span>
            )}
          </div>
          <div className="flex gap-2">
            {!bothConnected && (
              <Button
                size="sm"
                loading={test.isPending}
                onClick={async () => {
                  await test.mutateAsync(workspace.source!.id);
                  await test.mutateAsync(workspace.target!.id);
                }}
              >
                Verify both connections
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={!bothConnected}
              onClick={() => navigate('/compare')}
            >
              Continue to Analyze
            </Button>
          </div>
        </div>
      )}

      {(envs.isLoading || (discover.isPending && list.length === 0)) && (
        <Spinner label="Discovering environments…" />
      )}
      {envs.error && <ErrorState error={envs.error} onRetry={() => envs.refetch()} />}
      {!envs.isLoading && !discover.isPending && list.length === 0 && !discover.error && (
        <EmptyState
          icon={<Database className="h-8 w-8" />}
          title="No environments found"
          description="Your account does not have access to any Dataverse environments, or discovery has not run yet."
          action={<Button onClick={() => discover.mutate()}>Discover environments</Button>}
        />
      )}
      {list.length > 0 && filtered.length === 0 && <EmptyState title="No environments match your filters" />}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((env) => {
          const isSource = workspace.source?.id === env.id;
          const isTarget = workspace.target?.id === env.id;
          return (
            <article
              key={env.id}
              data-testid={`env-card-${env.displayName}`}
              className={cx(
                'flex flex-col rounded-lg border bg-white p-4 shadow-sm',
                isSource
                  ? 'border-[var(--color-source)] ring-1 ring-[var(--color-source)]'
                  : isTarget
                    ? 'border-[var(--color-target)] ring-1 ring-[var(--color-target)]'
                    : 'border-slate-200',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-slate-900">{env.displayName}</h3>
                  <p className="truncate font-mono text-xs text-slate-500">{env.url}</p>
                </div>
                <div className="flex flex-none flex-col items-end gap-1">
                  {isSource && (
                    <span className="rounded bg-[var(--color-source-soft)] px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-[var(--color-source)]">
                      SOURCE
                    </span>
                  )}
                  {isTarget && (
                    <span className="rounded bg-[var(--color-target-soft)] px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-[var(--color-target)]">
                      TARGET
                    </span>
                  )}
                  {env.provider === 'demo' && <Pill tone="amber">DEMO</Pill>}
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                <dt className="flex items-center gap-1 text-slate-500">
                  <Globe className="h-3 w-3" /> Type
                </dt>
                <dd className="text-slate-700">{env.environmentType ?? '—'}</dd>
                <dt className="flex items-center gap-1 text-slate-500">
                  <MapPin className="h-3 w-3" /> Region
                </dt>
                <dd className="text-slate-700">{env.region ?? '—'}</dd>
                <dt className="text-slate-500">Dataverse</dt>
                <dd className="text-slate-700">
                  {env.dataverseAvailable
                    ? `Available${env.version ? ` · v${env.version}` : ''}`
                    : 'Not available'}
                </dd>
                <dt className="text-slate-500">Identifier</dt>
                <dd
                  className="truncate font-mono text-slate-600"
                  title={env.organizationId ?? env.uniqueName ?? ''}
                >
                  {env.organizationId ?? env.uniqueName ?? '—'}
                </dd>
              </dl>
              <div className="mt-3 flex items-center gap-2 text-xs">
                <StatusBadge
                  status={env.connectionStatus}
                  label={env.connectionStatus === 'UNKNOWN' ? 'Not tested' : undefined}
                />
                {env.lastTestedAt && <span className="text-slate-400">{fmtRelative(env.lastTestedAt)}</span>}
              </div>
              {env.connectionMessage && (
                <p
                  className={cx(
                    'mt-1.5 flex items-start gap-1 text-xs',
                    env.connectionStatus === 'FAILED' ? 'text-red-700' : 'text-slate-500',
                  )}
                >
                  {env.connectionStatus === 'FAILED' ? (
                    <XCircle className="mt-0.5 h-3 w-3 flex-none" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-3 w-3 flex-none text-emerald-600" />
                  )}
                  {env.connectionMessage}
                </p>
              )}
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                <Button
                  size="sm"
                  icon={<PlugZap className="h-3.5 w-3.5" />}
                  loading={test.isPending && test.variables === env.id}
                  onClick={() => test.mutate(env.id)}
                  disabled={!env.dataverseAvailable}
                >
                  Test connection
                </Button>
                <Button
                  size="sm"
                  variant={isSource ? 'primary' : 'secondary'}
                  disabled={isSource || workspace.saving || !env.dataverseAvailable}
                  onClick={() => select('source', env)}
                >
                  {isSource ? 'Source' : 'Set as source'}
                </Button>
                <Button
                  size="sm"
                  variant={isTarget ? 'primary' : 'secondary'}
                  disabled={isTarget || workspace.saving || !env.dataverseAvailable}
                  onClick={() => select('target', env)}
                >
                  {isTarget ? 'Target' : 'Set as target'}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      {test.error && (
        <div className="mt-4">
          <ErrorState error={test.error} />
        </div>
      )}
      {list.length > 0 && !workspace.ready && (
        <div className="mt-6">
          <Callout tone="info" title="Choose a source and a target">
            The same environment cannot be both source and target. Your selection is remembered for your next
            visit.
          </Callout>
        </div>
      )}
    </>
  );
}
