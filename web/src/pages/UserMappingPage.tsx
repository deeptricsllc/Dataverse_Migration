import type {
  PrincipalMappingDto,
  PrincipalMappingSummaryDto,
  ImpersonationCapabilityDto,
} from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  Mono,
  PageHeader,
  Pill,
  SearchInput,
  Select,
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../components/ui';
import { get, post, put, qs } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { useWorkspace } from '../lib/session';

const TYPE_LABEL: Record<string, string> = {
  systemuser: 'User',
  team: 'Team',
  businessunit: 'Business unit',
};

export function UserMappingPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { source, target, ready } = useWorkspace();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'ALL' | 'UNMATCHED' | 'MATCHED'>('ALL');
  const key = ['principal-mappings', source?.id, target?.id];
  const params = qs({ sourceEnvironmentId: source?.id, targetEnvironmentId: target?.id });

  const mappings = useQuery({
    queryKey: key,
    queryFn: () => get<PrincipalMappingSummaryDto>(`/api/principal-mappings${params}`),
    enabled: ready,
  });
  const refresh = useMutation({
    mutationFn: (refreshDirectory: boolean) =>
      post<PrincipalMappingSummaryDto>('/api/principal-mappings/refresh', {
        sourceEnvironmentId: source!.id,
        targetEnvironmentId: target!.id,
        refreshDirectory,
      }),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
  const setMapping = useMutation({
    mutationFn: (body: {
      logicalName: string;
      sourceId: string;
      targetId: string | null;
      ignore?: boolean;
    }) =>
      put<PrincipalMappingDto>('/api/principal-mappings', {
        sourceEnvironmentId: source!.id,
        targetEnvironmentId: target!.id,
        ...body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const impersonation = useMutation({
    mutationFn: () =>
      post<ImpersonationCapabilityDto>('/api/principal-mappings/impersonation-check', {
        sourceEnvironmentId: source!.id,
        targetEnvironmentId: target!.id,
      }),
  });

  if (!ready) {
    return (
      <>
        <PageHeader title="User mapping" />
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title="Select a source and target first"
          action={
            <Button variant="primary" onClick={() => navigate('/environments')}>
              Select environments
            </Button>
          }
        />
      </>
    );
  }

  const data = mappings.data;
  const rows = (data?.mappings ?? []).filter(
    (m) =>
      (filter === 'ALL' ||
        (filter === 'UNMATCHED'
          ? m.status === 'UNMATCHED'
          : m.status === 'AUTO_MATCHED' || m.status === 'MANUAL')) &&
      `${m.source.name} ${m.source.email ?? ''} ${m.source.login ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  return (
    <>
      <PageHeader
        title="User mapping"
        description="Users, teams and business units have different record ids in every environment. This mapping lets the platform migrate ownership, created by / modified by, and any lookup that points at a user."
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search users" />
            <Select
              label="Filter"
              value={filter}
              onChange={(v) => setFilter(v as typeof filter)}
              options={[
                { value: 'ALL', label: 'All' },
                { value: 'UNMATCHED', label: 'Unmatched only' },
                { value: 'MATCHED', label: 'Matched only' },
              ]}
            />
            <ExportButton href={`/api/principal-mappings.csv${params}`} label="Export CSV" />
            <Button
              icon={<RefreshCw className="h-4 w-4" />}
              loading={refresh.isPending}
              onClick={() => refresh.mutate(true)}
            >
              Refresh directories
            </Button>
          </>
        }
      />
      {refresh.error && (
        <div className="mb-4">
          <ErrorState error={refresh.error} />
        </div>
      )}
      {setMapping.error && (
        <div className="mb-4">
          <ErrorState error={setMapping.error} />
        </div>
      )}
      {mappings.isLoading && <Spinner />}
      {mappings.error && <ErrorState error={mappings.error} onRetry={() => mappings.refetch()} />}

      {data && data.mappings.length === 0 && (
        <Card>
          <EmptyState
            icon={<Users className="h-8 w-8" />}
            title="No user directory loaded yet"
            description={`Read the users, teams and business units of ${source!.displayName} and ${target!.displayName} and match them automatically.`}
            action={
              <Button variant="primary" loading={refresh.isPending} onClick={() => refresh.mutate(true)}>
                Load and match users
              </Button>
            }
          />
        </Card>
      )}

      {data && data.mappings.length > 0 && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Principals"
              value={data.counts.total}
              hint={`refreshed ${fmtRelative(data.refreshedAt)}`}
            />
            <Stat
              label="Matched"
              tone="green"
              value={data.counts.matched}
              hint={`${data.counts.manual} manual`}
            />
            <Stat
              label="Unmatched"
              tone={data.counts.unmatched ? 'amber' : 'default'}
              value={data.counts.unmatched}
              onClick={() => setFilter('UNMATCHED')}
            />
            <Stat label="Excluded" tone="slate" value={data.counts.ignored} />
          </div>

          <Card
            title="Impersonation check"
            subtitle="Preserving created by / modified by writes records as the mapped user, which needs the “Act on Behalf of Another User” privilege in the target."
            actions={
              <Button
                icon={<ShieldCheck className="h-4 w-4" />}
                loading={impersonation.isPending}
                onClick={() => impersonation.mutate()}
              >
                Run check
              </Button>
            }
          >
            {impersonation.data ? (
              <Callout tone={impersonation.data.canImpersonate ? 'success' : 'warning'}>
                {impersonation.data.message}
              </Callout>
            ) : impersonation.error ? (
              <ErrorState error={impersonation.error} />
            ) : (
              <p className="text-sm text-slate-500">
                Read-only check against {target!.displayName}. Nothing is written.
              </p>
            )}
          </Card>

          <Card title="Mappings" subtitle={`${rows.length} shown`} bodyClassName="p-0">
            <Table>
              <thead className="bg-slate-50">
                <tr>
                  <Th>Type</Th>
                  <Th>Source</Th>
                  <Th>Target</Th>
                  <Th>Status</Th>
                  <Th>Matched by</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((m) => (
                  <tr key={`${m.logicalName}:${m.source.id}`} data-testid={`principal-${m.source.name}`}>
                    <Td className="text-xs text-slate-500">{TYPE_LABEL[m.logicalName] ?? m.logicalName}</Td>
                    <Td>
                      <div className="font-medium text-slate-900">{m.source.name}</div>
                      <div className="text-xs text-slate-500">{m.source.email ?? m.source.login ?? '—'}</div>
                      <Mono className="text-[11px]">{m.source.id}</Mono>
                    </Td>
                    <Td>
                      <select
                        aria-label={`Target for ${m.source.name}`}
                        value={m.target?.id ?? ''}
                        disabled={setMapping.isPending}
                        onChange={(e) =>
                          setMapping.mutate({
                            logicalName: m.logicalName,
                            sourceId: m.source.id,
                            targetId: e.target.value || null,
                          })
                        }
                        className="max-w-[260px] rounded border border-slate-300 bg-white py-1 pl-2 pr-7 text-xs"
                      >
                        <option value="">— not mapped —</option>
                        {data.targetPrincipals[m.logicalName].map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                            {t.email ? ` (${t.email})` : ''}
                            {t.disabled ? ' · disabled' : ''}
                          </option>
                        ))}
                      </select>
                    </Td>
                    <Td>
                      <StatusBadge
                        status={
                          m.status === 'AUTO_MATCHED'
                            ? 'AUTO_MAPPED'
                            : m.status === 'MANUAL'
                              ? 'MANUAL'
                              : m.status === 'IGNORED'
                                ? 'IGNORED'
                                : 'UNMAPPED'
                        }
                        label={m.status === 'UNMATCHED' ? 'Unmatched' : undefined}
                      />
                      {m.note && <div className="mt-0.5 max-w-xs text-[11px] text-slate-500">{m.note}</div>}
                    </Td>
                    <Td className="text-xs text-slate-600">
                      {m.matchMethod ? (
                        <>
                          {m.matchMethod.replace(/_/g, ' ').toLowerCase()} <Pill>{m.confidence}%</Pill>
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setMapping.mutate({
                            logicalName: m.logicalName,
                            sourceId: m.source.id,
                            targetId: null,
                            ignore: m.status !== 'IGNORED',
                          })
                        }
                      >
                        {m.status === 'IGNORED' ? 'Include' : 'Exclude'}
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Callout tone="info" title="What can and cannot be preserved">
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              <li>
                <strong>Owner</strong> and <strong>created on</strong> are written directly by the migration.
              </li>
              <li>
                <strong>Created by</strong> and <strong>modified by</strong> are only reachable by
                impersonating the mapped user, which requires the privilege above.
              </li>
              <li>
                <strong>Modified on</strong> always becomes the migration time: Dataverse does not allow it to
                be set.
              </li>
              <li>
                Unmatched users fall back to the migrating user, and every fallback is reported per record.
              </li>
            </ul>
          </Callout>
        </div>
      )}
    </>
  );
}
