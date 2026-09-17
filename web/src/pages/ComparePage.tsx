import type { ColumnDiff, ComparisonRunDto, DiffStatus, ProfileDto, TableDiff } from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, GitCompareArrows, RefreshCw } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { WizardSteps } from '../components/WizardSteps';
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
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Tabs,
  Td,
  Th,
} from '../components/ui';
import { get, post, qs } from '../lib/api';
import { fmtNumber, fmtRelative } from '../lib/format';
import { useWorkspace } from '../lib/session';

type Filter = 'ALL' | DiffStatus;

export function ComparePage() {
  const { comparisonId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { source, target, ready } = useWorkspace();

  const latest = useQuery({
    queryKey: ['comparisons', source?.id, target?.id],
    queryFn: () =>
      get<ComparisonRunDto[]>(
        `/api/comparisons${qs({ sourceEnvironmentId: source?.id, targetEnvironmentId: target?.id })}`,
      ),
    enabled: !comparisonId && ready,
  });
  const activeId = comparisonId ?? latest.data?.[0]?.id;

  const run = useQuery({
    queryKey: ['comparison', activeId],
    queryFn: () => get<ComparisonRunDto>(`/api/comparisons/${activeId}`),
    enabled: Boolean(activeId),
    refetchInterval: (q) =>
      q.state.data && ['QUEUED', 'RUNNING'].includes(q.state.data.status) ? 1000 : false,
  });
  const completed = run.data?.status === 'COMPLETED';
  const tables = useQuery({
    queryKey: ['comparison-tables', activeId],
    queryFn: () => get<TableDiff[]>(`/api/comparisons/${activeId}/tables`),
    enabled: Boolean(activeId) && completed,
  });

  const analyze = useMutation({
    mutationFn: (refreshMetadata: boolean) =>
      post<ComparisonRunDto>('/api/comparisons', {
        sourceEnvironmentId: source!.id,
        targetEnvironmentId: target!.id,
        refreshMetadata,
      }),
    onSuccess: (data) => {
      qc.setQueryData(['comparison', data.id], data);
      void qc.invalidateQueries({ queryKey: ['comparisons'] });
      navigate(`/compare/${data.id}`);
    },
  });

  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');
  const [customOnly, setCustomOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      (tables.data ?? []).filter(
        (t) =>
          (filter === 'ALL' || t.status === filter) &&
          (!customOnly || t.isCustom) &&
          `${t.logicalName} ${t.displayName}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [tables.data, filter, search, customOnly],
  );

  const pairMismatch =
    run.data &&
    source &&
    target &&
    (run.data.sourceEnvironment.id !== source.id || run.data.targetEnvironment.id !== target.id);

  if (!ready) {
    return (
      <>
        <WizardSteps current={2} links={{ 1: '/environments' }} />
        <EmptyState
          icon={<GitCompareArrows className="h-8 w-8" />}
          title="Select a source and target first"
          description="Choose both environments to analyze their differences."
          action={
            <Button variant="primary" onClick={() => navigate('/environments')}>
              Select environments
            </Button>
          }
        />
      </>
    );
  }

  const s = run.data?.summary;
  return (
    <>
      <WizardSteps current={2} links={{ 1: '/environments', 3: '/migration/new' }} />
      <PageHeader
        title="Compare environments"
        description="Schema comparison of tables, columns, relationships and alternate keys. Column-level analysis covers custom tables and common business tables."
        actions={
          <>
            {run.data && (
              <Button
                icon={<RefreshCw className="h-4 w-4" />}
                loading={analyze.isPending}
                onClick={() => analyze.mutate(true)}
              >
                Re-analyze (refresh metadata)
              </Button>
            )}
            {!run.data && (
              <Button
                variant="primary"
                icon={<GitCompareArrows className="h-4 w-4" />}
                loading={analyze.isPending}
                onClick={() => analyze.mutate(false)}
              >
                Analyze
              </Button>
            )}
            {completed && (
              <ExportButton
                href={`/api/comparisons/${activeId}/tables.csv`}
                label="Export differences"
                size="md"
              />
            )}
            {completed && !pairMismatch && (
              <Button variant="primary" onClick={() => navigate('/migration/new')}>
                Continue: Select tables
              </Button>
            )}
          </>
        }
      />
      {analyze.error && (
        <div className="mb-4">
          <ErrorState error={analyze.error} />
        </div>
      )}
      {pairMismatch && (
        <div className="mb-4">
          <Callout tone="warning" title="This comparison is for a different environment pair">
            {run.data!.sourceEnvironment.displayName} → {run.data!.targetEnvironment.displayName}.{' '}
            <button type="button" className="font-medium underline" onClick={() => analyze.mutate(false)}>
              Analyze the current workspace
            </button>
          </Callout>
        </div>
      )}
      {(latest.isLoading || run.isLoading) && <Spinner />}
      {latest.data && latest.data.length === 0 && !comparisonId && (
        <Card>
          <EmptyState
            icon={<GitCompareArrows className="h-8 w-8" />}
            title="No analysis yet for this pair"
            description={`Analyze ${source!.displayName} and ${target!.displayName} to discover metadata and schema differences.`}
            action={
              <Button variant="primary" loading={analyze.isPending} onClick={() => analyze.mutate(false)}>
                Analyze now
              </Button>
            }
          />
        </Card>
      )}
      {run.error && <ErrorState error={run.error} />}
      {run.data && ['QUEUED', 'RUNNING'].includes(run.data.status) && (
        <Card>
          <div className="flex items-center gap-3">
            <StatusBadge status={run.data.status} />
            <span className="text-sm text-slate-600">{run.data.progressMessage}</span>
          </div>
        </Card>
      )}
      {run.data?.status === 'FAILED' && (
        <ErrorState
          error={new Error(`Analysis failed: ${run.data.errorMessage}`)}
          onRetry={() => analyze.mutate(true)}
        />
      )}

      {completed && s && (
        <div className="space-y-5">
          <p className="text-xs text-slate-500">
            Analyzed {fmtRelative(run.data!.completedAt)} by {run.data!.createdBy ?? 'unknown'} ·{' '}
            {s.deepCompared} tables compared column by column
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat
              label="Tables compared"
              value={s.tablesCompared}
              onClick={() => setFilter('ALL')}
              active={filter === 'ALL'}
            />
            <Stat
              label="Matching"
              tone="green"
              value={s.match}
              onClick={() => setFilter('MATCH')}
              active={filter === 'MATCH'}
            />
            <Stat
              label="Different"
              tone="amber"
              value={s.different}
              onClick={() => setFilter('DIFFERENT')}
              active={filter === 'DIFFERENT'}
            />
            <Stat
              label="Missing in target"
              tone="violet"
              value={s.sourceOnly}
              onClick={() => setFilter('SOURCE_ONLY')}
              active={filter === 'SOURCE_ONLY'}
            />
            <Stat
              label="Target-only"
              tone="blue"
              value={s.targetOnly}
              onClick={() => setFilter('TARGET_ONLY')}
              active={filter === 'TARGET_ONLY'}
            />
            <Stat
              label="Potentially incompatible"
              tone="red"
              value={s.incompatible}
              onClick={() => setFilter('INCOMPATIBLE')}
              active={filter === 'INCOMPATIBLE'}
            />
          </div>
          <Card
            title="Tables"
            subtitle={`${rows.length} shown`}
            actions={
              <>
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={customOnly}
                    onChange={(e) => setCustomOnly(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />{' '}
                  Custom only
                </label>
                <SearchInput value={search} onChange={setSearch} placeholder="Search tables" />
              </>
            }
            bodyClassName="p-0"
          >
            {tables.isLoading && <Spinner />}
            {tables.error && (
              <div className="p-4">
                <ErrorState error={tables.error} />
              </div>
            )}
            {tables.data && rows.length === 0 && <EmptyState title="No tables match the current filter" />}
            {rows.length > 0 && (
              <Table>
                <thead className="bg-slate-50">
                  <tr>
                    <Th className="w-8" />
                    <Th>Table</Th>
                    <Th>Status</Th>
                    <Th>Columns</Th>
                    <Th>Relationships</Th>
                    <Th>Keys</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((t) => {
                    const isOpen = expanded === t.logicalName;
                    const colDiffs = t.columns.filter((c) => c.status !== 'MATCH').length;
                    return (
                      <Fragment key={t.logicalName}>
                        <tr
                          className="cursor-pointer hover:bg-slate-50"
                          onClick={() => setExpanded(isOpen ? null : t.logicalName)}
                          data-testid={`diff-row-${t.logicalName}`}
                        >
                          <Td>
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-label={`Expand ${t.displayName}`}
                              className="text-slate-400"
                            >
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </button>
                          </Td>
                          <Td>
                            <div className="font-medium text-slate-900">{t.displayName}</div>
                            <Mono>{t.logicalName}</Mono> {t.isCustom && <Pill>custom</Pill>}
                          </Td>
                          <Td>
                            <StatusBadge status={t.status} />
                          </Td>
                          <Td className="text-xs">
                            {t.deep ? (
                              colDiffs ? (
                                <span className="text-amber-700">
                                  {colDiffs} difference(s) of {t.columns.length}
                                </span>
                              ) : (
                                <span className="text-slate-500">{t.columns.length} match</span>
                              )
                            ) : (
                              <span className="text-slate-400">not analyzed</span>
                            )}
                          </Td>
                          <Td className="text-xs text-slate-500">
                            {t.deep
                              ? `${t.relationships.filter((r) => r.status !== 'MATCH').length} diff / ${t.relationships.length}`
                              : '—'}
                          </Td>
                          <Td className="text-xs text-slate-500">
                            {t.deep
                              ? `${t.keys.filter((k) => k.status !== 'MATCH').length} diff / ${t.keys.length}`
                              : '—'}
                          </Td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={6} className="bg-slate-50/70 px-6 py-4">
                              <TableDetail
                                table={t}
                                sourceId={run.data!.sourceEnvironment.id}
                                targetId={run.data!.targetEnvironment.id}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function TableDetail({
  table,
  sourceId,
  targetId,
}: {
  table: TableDiff;
  sourceId: string;
  targetId: string;
}) {
  const [tab, setTab] = useState<'columns' | 'relationships' | 'keys' | 'profile'>('columns');
  const [showMatches, setShowMatches] = useState(false);
  if (!table.deep) {
    return (
      <p className="text-sm text-slate-600">
        {table.status === 'SOURCE_ONLY' &&
          'This table does not exist in the target environment. Deploy it (solution import) before migrating its data.'}
        {table.status === 'TARGET_ONLY' && 'This table exists only in the target environment.'}
        {table.status === 'MATCH' &&
          'Table exists in both environments. Column-level analysis was not requested for this table.'}
        {table.status === 'INCOMPATIBLE' && 'Primary key definitions differ between environments.'}
      </p>
    );
  }
  const columns = showMatches ? table.columns : table.columns.filter((c) => c.status !== 'MATCH');
  return (
    <div className="space-y-3">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'columns', label: `Columns (${table.columns.length})` },
          { value: 'relationships', label: `Relationships (${table.relationships.length})` },
          { value: 'keys', label: `Keys (${table.keys.length})` },
          { value: 'profile', label: 'Data profile' },
        ]}
      />
      {table.differences.length > 0 && (
        <Callout tone="warning" title="Table-level differences">
          {table.differences
            .map((d) => `${d.property}: ${String(d.source)} → ${String(d.target)}`)
            .join('; ')}
        </Callout>
      )}
      {tab === 'columns' && (
        <>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={showMatches}
              onChange={(e) => setShowMatches(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300"
            />{' '}
            Show matching columns
          </label>
          {columns.length === 0 ? (
            <p className="text-sm text-slate-500">All columns match.</p>
          ) : (
            <Table className="rounded-md border border-slate-200 bg-white">
              <thead className="bg-slate-50">
                <tr>
                  <Th>Column</Th>
                  <Th>Status</Th>
                  <Th>Source type</Th>
                  <Th>Target type</Th>
                  <Th>Required (S / T)</Th>
                  <Th>Differences</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {columns.map((c) => (
                  <ColumnRow key={c.logicalName} c={c} />
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
      {tab === 'relationships' &&
        (table.relationships.length === 0 ? (
          <p className="text-sm text-slate-500">No lookup relationships.</p>
        ) : (
          <Table className="rounded-md border border-slate-200 bg-white">
            <thead className="bg-slate-50">
              <tr>
                <Th>Relationship</Th>
                <Th>Lookup column</Th>
                <Th>References</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.relationships.map((r) => (
                <tr key={r.schemaName + r.referencingAttribute + (r.sourceTarget ?? r.targetTarget)}>
                  <Td>
                    <Mono>{r.schemaName}</Mono>
                  </Td>
                  <Td>
                    <Mono>{r.referencingAttribute}</Mono>
                  </Td>
                  <Td>{r.sourceTarget ?? r.targetTarget}</Td>
                  <Td>
                    <StatusBadge status={r.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
      {tab === 'keys' &&
        (table.keys.length === 0 ? (
          <p className="text-sm text-slate-500">No alternate keys defined in either environment.</p>
        ) : (
          <Table className="rounded-md border border-slate-200 bg-white">
            <thead className="bg-slate-50">
              <tr>
                <Th>Key</Th>
                <Th>Source columns</Th>
                <Th>Target columns</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.keys.map((k) => (
                <tr key={k.logicalName}>
                  <Td>
                    <Mono>{k.logicalName}</Mono>
                  </Td>
                  <Td>{k.sourceAttributes?.join(', ') ?? '—'}</Td>
                  <Td>{k.targetAttributes?.join(', ') ?? '—'}</Td>
                  <Td>
                    <StatusBadge status={k.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
      {tab === 'profile' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ProfilePanel role="Source" environmentId={sourceId} table={table.logicalName} />
          <ProfilePanel role="Target" environmentId={targetId} table={table.logicalName} />
        </div>
      )}
    </div>
  );
}

function ColumnRow({ c }: { c: ColumnDiff }) {
  return (
    <tr>
      <Td>
        <div className="text-slate-900">{c.displayName}</div>
        <Mono>{c.logicalName}</Mono>
      </Td>
      <Td>
        <StatusBadge status={c.status} />
      </Td>
      <Td className="text-xs">{c.sourceType ?? '—'}</Td>
      <Td className="text-xs">{c.targetType ?? '—'}</Td>
      <Td className="text-xs text-slate-500">
        {c.sourceRequired ?? '—'} / {c.targetRequired ?? '—'}
      </Td>
      <Td className="text-xs">
        {c.differences.length === 0 ? (
          <span className="text-slate-400">—</span>
        ) : (
          <ul className="space-y-0.5">
            {c.differences.map((d) => (
              <li key={d.property} className={d.breaking ? 'text-red-700' : 'text-slate-600'}>
                <span className="font-medium">{d.property}</span>: {formatValue(d.source)} →{' '}
                {formatValue(d.target)}
                {d.note && <span className="block text-slate-500">{d.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </Td>
    </tr>
  );
}

const formatValue = (v: unknown) =>
  Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v === null || v === undefined ? '—' : String(v);

function ProfilePanel({
  role,
  environmentId,
  table,
}: {
  role: string;
  environmentId: string;
  table: string;
}) {
  const q = useQuery({
    queryKey: ['profile', environmentId, table],
    queryFn: () => get<ProfileDto>(`/api/environments/${environmentId}/tables/${table}/profile`),
  });
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{role}</h4>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} />}
      {q.data && (
        <div className="mt-2 space-y-3 text-sm">
          <div>
            <span className="text-2xl font-semibold tabular-nums">{fmtNumber(q.data.count)}</span> records
            {q.data.countApproximate && ' (approx.)'}
            <div className="text-xs text-slate-500">
              Primary id <Mono>{q.data.primaryIdAttribute}</Mono> · name{' '}
              <Mono>{q.data.primaryNameAttribute ?? '—'}</Mono> · null statistics from {q.data.sampleSize}{' '}
              sampled records
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-xs">
              <tbody>
                {q.data.nullStats.map((n) => (
                  <tr key={n.field}>
                    <td className="py-0.5 pr-2 text-slate-600">{n.displayName}</td>
                    <td className="w-24 py-0.5">
                      <div className="h-1.5 rounded bg-slate-100">
                        <div className="h-1.5 rounded bg-slate-400" style={{ width: `${n.nullPercent}%` }} />
                      </div>
                    </td>
                    <td className="w-14 py-0.5 text-right tabular-nums text-slate-500">
                      {n.nullPercent}% null
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {q.data.sampleRecords.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-medium text-brand-700">
                Sample records ({q.data.sampleRecords.length})
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-900 p-3 text-[11px] text-slate-100">
                {JSON.stringify(q.data.sampleRecords, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
