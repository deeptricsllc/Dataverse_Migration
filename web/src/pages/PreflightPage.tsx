import type { PreflightAction, PreflightRecordDto, PreflightRunDto } from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, ChevronRight, Play } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
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
  Select,
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../components/ui';
import { get, post, qs } from '../lib/api';
import { fmtDate, fmtNumber } from '../lib/format';
import { Pager } from './RunDetailPage';

const PAGE = 50;

const ACTION_TONE: Record<PreflightAction, 'teal' | 'blue' | 'slate' | 'amber' | 'red'> = {
  CREATE: 'teal',
  UPDATE: 'blue',
  UNCHANGED: 'slate',
  CONFLICT: 'amber',
  BLOCKED: 'red',
};

export function PreflightPage() {
  const { planId } = useParams();
  const qc = useQueryClient();
  const [action, setAction] = useState<PreflightAction | ''>('');
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const runQuery = useQuery({
    queryKey: ['preflight', planId],
    queryFn: () => get<PreflightRunDto | null>(`/api/plans/${planId}/preflight`),
    refetchInterval: (q) =>
      q.state.data && ['QUEUED', 'RUNNING'].includes(q.state.data.status) ? 1000 : false,
  });
  const start = useMutation({
    mutationFn: () => post<PreflightRunDto>(`/api/plans/${planId}/preflight`),
    onSuccess: (data) => qc.setQueryData(['preflight', planId], data),
  });

  const run = runQuery.data;
  const done = run?.status === 'COMPLETED';
  const records = useQuery({
    queryKey: ['preflight-records', run?.id, action, entity, page],
    queryFn: () =>
      get<{ items: PreflightRecordDto[]; total: number }>(
        `/api/preflight/${run!.id}/records${qs({ action: action || undefined, entity: entity || undefined, limit: PAGE, offset: page * PAGE })}`,
      ),
    enabled: Boolean(done && run),
  });

  if (runQuery.isLoading) return <Spinner label="Loading preflight…" />;
  if (runQuery.error) return <ErrorState error={runQuery.error} onRetry={() => runQuery.refetch()} />;

  const filter = (next: PreflightAction | '') => {
    setAction(next);
    setPage(0);
  };

  return (
    <>
      <PageHeader
        title="Preflight — dry run"
        description={
          run ? (
            <>
              <span className="text-[var(--color-source)]">{run.sourceEnvironment.displayName}</span>{' '}
              <ArrowRight className="inline h-3.5 w-3.5" />{' '}
              <span className="text-[var(--color-target)]">{run.targetEnvironment.displayName}</span> ·{' '}
              {fmtDate(run.createdAt)}
              {run.createdBy && ` · by ${run.createdBy}`} ·{' '}
              <Link to={`/migration/plans/${planId}`} className="font-medium text-brand-700 hover:underline">
                back to plan
              </Link>
            </>
          ) : (
            'Analyzes exactly what the migration would do. No records are written to Dataverse.'
          )
        }
        actions={
          <>
            {run && <StatusBadge status={run.status} />}
            <Button
              variant="primary"
              icon={<Play className="h-4 w-4" />}
              loading={start.isPending || ['QUEUED', 'RUNNING'].includes(run?.status ?? '')}
              onClick={() => start.mutate()}
              data-testid="run-preflight"
            >
              {run ? 'Run again' : 'Run preflight'}
            </Button>
          </>
        }
      />

      {start.error && <ErrorState error={start.error} />}

      {!run && !start.isPending && (
        <EmptyState
          title="No preflight yet"
          description="A preflight reads both environments and classifies every source record as create, update, unchanged, conflict or blocked. It never writes."
        />
      )}

      {run && ['QUEUED', 'RUNNING'].includes(run.status) && (
        <Card>
          <div className="flex items-center gap-3 text-sm text-slate-600">
            <StatusBadge status={run.status} /> {run.progressMessage ?? 'Analyzing…'}
          </div>
        </Card>
      )}

      {run?.status === 'FAILED' && <ErrorState error={new Error(`Preflight failed: ${run.errorMessage}`)} />}

      {done && run && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Source records" value={fmtNumber(run.totals.sourceRecords)} hint="analyzed" />
            <Stat
              label="Create"
              tone="green"
              value={fmtNumber(run.totals.create)}
              active={action === 'CREATE'}
              onClick={() => filter('CREATE')}
            />
            <Stat
              label="Update"
              tone="blue"
              value={fmtNumber(run.totals.update)}
              active={action === 'UPDATE'}
              onClick={() => filter('UPDATE')}
            />
            <Stat
              label="Unchanged"
              tone="slate"
              value={fmtNumber(run.totals.unchanged)}
              hint="no Dataverse write"
              active={action === 'UNCHANGED'}
              onClick={() => filter('UNCHANGED')}
            />
            <Stat
              label="Conflict"
              tone="amber"
              value={fmtNumber(run.totals.conflict)}
              active={action === 'CONFLICT'}
              onClick={() => filter('CONFLICT')}
            />
            <Stat
              label="Blocked"
              tone="red"
              value={fmtNumber(run.totals.blocked)}
              active={action === 'BLOCKED'}
              onClick={() => filter('BLOCKED')}
            />
          </div>

          {run.totals.create === 0 && run.totals.update === 0 && run.totals.sourceRecords > 0 && (
            <Callout tone="success" title="Nothing to write">
              Source and target are logically identical for the selected tables. Executing this plan would
              perform zero Dataverse writes, so no modified on / modified by values would change.
            </Callout>
          )}

          <IdentityImpact run={run} />

          <Card
            title="By table"
            actions={
              <ExportButton
                href={`/api/preflight/${run.id}/records.csv${qs({ action: action || undefined, entity: entity || undefined })}`}
                label="Export preflight CSV"
              />
            }
            bodyClassName="p-0"
          >
            <Table>
              <thead>
                <tr>
                  <Th>Table</Th>
                  <Th>Matched by</Th>
                  <Th className="text-right">Source</Th>
                  <Th className="text-right">Create</Th>
                  <Th className="text-right">Update</Th>
                  <Th className="text-right">Unchanged</Th>
                  <Th className="text-right">Conflict</Th>
                  <Th className="text-right">Blocked</Th>
                </tr>
              </thead>
              <tbody>
                {run.entities.map((e) => (
                  <tr
                    key={e.logicalName}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => {
                      setEntity(entity === e.logicalName ? '' : e.logicalName);
                      setPage(0);
                    }}
                  >
                    <Td>
                      <span className="font-medium text-slate-900">{e.displayName}</span>{' '}
                      <Mono className="text-xs text-slate-500">{e.logicalName}</Mono>
                      {e.sampled && (
                        <Pill tone="amber" title="Only part of this table was analyzed">
                          sampled
                        </Pill>
                      )}
                    </Td>
                    <Td className="text-xs text-slate-600">{e.matchDescription}</Td>
                    <Td className="text-right">{fmtNumber(e.sourceRecords)}</Td>
                    <Td className="text-right text-emerald-700">{fmtNumber(e.create)}</Td>
                    <Td className="text-right text-brand-700">{fmtNumber(e.update)}</Td>
                    <Td className="text-right text-slate-500">{fmtNumber(e.unchanged)}</Td>
                    <Td className="text-right text-amber-700">{fmtNumber(e.conflict)}</Td>
                    <Td className="text-right text-red-700">{fmtNumber(e.blocked)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card
            title="Records"
            subtitle="Every row shows what would happen and why. Expand a row to see the field-level changes."
            actions={
              <div className="flex items-center gap-2">
                <Select
                  label="Action"
                  value={action}
                  onChange={(v) => filter(v as PreflightAction | '')}
                  options={[
                    { value: '', label: 'All actions' },
                    { value: 'CREATE', label: 'Create' },
                    { value: 'UPDATE', label: 'Update' },
                    { value: 'UNCHANGED', label: 'Unchanged' },
                    { value: 'CONFLICT', label: 'Conflict' },
                    { value: 'BLOCKED', label: 'Blocked' },
                  ]}
                />
                <Select
                  label="Table"
                  value={entity}
                  onChange={(v) => {
                    setEntity(v);
                    setPage(0);
                  }}
                  options={[
                    { value: '', label: 'All tables' },
                    ...run.entities.map((e) => ({ value: e.logicalName, label: e.displayName })),
                  ]}
                />
              </div>
            }
            bodyClassName="p-0"
          >
            {records.isLoading && <Spinner label="Loading records…" />}
            {records.error && <ErrorState error={records.error} />}
            {records.data && records.data.items.length === 0 && (
              <p className="px-5 py-6 text-sm text-slate-500">No records match this filter.</p>
            )}
            {records.data && records.data.items.length > 0 && (
              <>
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-8" />
                      <Th>Table</Th>
                      <Th>Record</Th>
                      <Th>Action</Th>
                      <Th>Matched by</Th>
                      <Th>Reason</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.data.items.map((r) => {
                      const open = expanded === r.id;
                      const changes = r.changes.filter((c) => c.action !== 'UNCHANGED');
                      return (
                        <Fragment key={r.id}>
                          <tr
                            className="cursor-pointer hover:bg-slate-50"
                            onClick={() => setExpanded(open ? null : r.id)}
                          >
                            <Td>
                              {changes.length ? (
                                open ? (
                                  <ChevronDown className="h-4 w-4 text-slate-400" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-slate-400" />
                                )
                              ) : null}
                            </Td>
                            <Td>
                              <Mono className="text-xs">{r.entity}</Mono>
                            </Td>
                            <Td>
                              <span className="text-slate-900">{r.recordName ?? '—'}</span>
                              <Mono className="ml-2 text-[11px] text-slate-400">{r.sourceRecordId}</Mono>
                            </Td>
                            <Td>
                              <Pill tone={ACTION_TONE[r.action]}>{r.action}</Pill>
                            </Td>
                            <Td className="text-xs text-slate-600">{r.matchMethod ?? '—'}</Td>
                            <Td className="text-xs text-slate-600">{r.reason ?? '—'}</Td>
                          </tr>
                          {open && changes.length > 0 && (
                            <tr className="bg-slate-50/70">
                              <Td />
                              <td colSpan={5} className="px-3 py-3">
                                <Table>
                                  <thead>
                                    <tr>
                                      <Th>Field</Th>
                                      <Th>Source value</Th>
                                      <Th>Target value</Th>
                                      <Th>Proposed action</Th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {changes.map((c) => (
                                      <tr key={c.field}>
                                        <Td>
                                          {c.displayName}{' '}
                                          <Mono className="text-[11px] text-slate-400">{c.field}</Mono>
                                        </Td>
                                        <Td>{c.sourceValue ?? <span className="text-slate-400">—</span>}</Td>
                                        <Td>{c.targetValue ?? <span className="text-slate-400">—</span>}</Td>
                                        <Td>
                                          <Pill tone={c.action === 'CLEAR' ? 'amber' : 'blue'}>
                                            {c.action}
                                          </Pill>
                                        </Td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </Table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </Table>
                <Pager page={page} total={records.data.total} onPage={setPage} />
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function IdentityImpact({ run }: { run: PreflightRunDto }) {
  const impact = run.identityImpact;
  if (!impact.unresolvedPrincipals.length) return null;
  const fallback = impact.policy === 'FALLBACK' && impact.fallbackPrincipal;
  return (
    <Card
      title={fallback ? 'Ownership substitutions that would be applied' : 'Unresolved identities'}
      subtitle={
        fallback
          ? `${fmtNumber(impact.recordsAffected)} record(s) would be attributed to ${impact.fallbackPrincipal!.name} instead of their source identity, across ${impact.fieldsAffected.join(', ')}.`
          : `${fmtNumber(impact.recordsAffected)} record(s) are blocked because their user references cannot be resolved (STRICT policy).`
      }
      bodyClassName="p-0"
    >
      <div className="px-5 pt-4">
        <Callout tone={fallback ? 'warning' : 'danger'} title={`User resolution policy: ${impact.policy}`}>
          {fallback
            ? 'Every substitution below is recorded per record and exported in the remediation package. Acknowledge it on the plan page before executing.'
            : 'Under STRICT, these records are never written with a substituted owner. Map or exclude the identities, or switch to FALLBACK.'}
        </Callout>
      </div>
      <Table className="mt-3">
        <thead>
          <tr>
            <Th>Type</Th>
            <Th>Source identity</Th>
            <Th className="text-right">Records</Th>
            <Th>Fields</Th>
          </tr>
        </thead>
        <tbody>
          {impact.unresolvedPrincipals.map((p) => (
            <tr key={`${p.logicalName}:${p.id}`}>
              <Td>
                <Mono className="text-xs">{p.logicalName}</Mono>
              </Td>
              <Td>
                {p.name ?? <span className="text-slate-400">unknown</span>}{' '}
                <Mono className="text-[11px] text-slate-400">{p.id}</Mono>
              </Td>
              <Td className="text-right">{fmtNumber(p.records)}</Td>
              <Td className="text-xs text-slate-600">{p.fields.join(', ')}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
