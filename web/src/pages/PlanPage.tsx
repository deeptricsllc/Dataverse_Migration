import type {
  ConflictStrategy,
  DependencyEdgeDto,
  FieldMappingDto,
  MappingStatus,
  MigrationPlanDto,
  MigrationRunDto,
  PlanEntityDto,
  PlanIssue,
  PlanOptions,
  TableCandidateDto,
} from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Lightbulb, Play, RefreshCw, RotateCcw, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { TableSelector } from '../components/TableSelector';
import { WizardSteps } from '../components/WizardSteps';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Modal,
  Mono,
  PageHeader,
  Pill,
  Select,
  Spinner,
  StatusBadge,
  Table,
  Tabs,
  Td,
  Th,
  cx,
} from '../components/ui';
import { get, patch, post, put, qs } from '../lib/api';
import { fmtNumber, fmtRelative } from '../lib/format';

type Step = 'tables' | 'dependencies' | 'mapping' | 'review';
const STEP_NUMBER: Record<Step, number> = { tables: 3, dependencies: 4, mapping: 5, review: 6 };

export function PlanPage() {
  const { planId } = useParams();
  const [params, setParams] = useSearchParams();
  const step = (params.get('step') as Step) || 'review';
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ['plan', planId], queryFn: () => get<MigrationPlanDto>(`/api/plans/${planId}`) });
  const setStep = (s: Step) => setParams({ step: s });
  const setPlan = (p: MigrationPlanDto) => qc.setQueryData(['plan', planId], p);

  if (plan.isLoading) return <Spinner label="Loading plan…" />;
  if (plan.error || !plan.data) return <ErrorState error={plan.error ?? new Error('Plan not found')} />;
  const p = plan.data;
  const base = `/migration/plans/${p.id}`;

  return (
    <>
      <WizardSteps
        current={STEP_NUMBER[step]}
        links={{
          1: '/environments',
          2: p.comparisonRunId ? `/compare/${p.comparisonRunId}` : '/compare',
          3: `${base}?step=tables`,
          4: `${base}?step=dependencies`,
          5: `${base}?step=mapping`,
          6: `${base}?step=review`,
          ...(p.lastRunId ? { 7: `/runs/${p.lastRunId}` } : {}),
        }}
      />
      <PageHeader
        title={p.name}
        description={
          <>
            <span className="font-medium text-[var(--color-source)]">{p.sourceEnvironment.displayName}</span> <ArrowRight className="inline h-3.5 w-3.5" />{' '}
            <span className="font-medium text-[var(--color-target)]">{p.targetEnvironment.displayName}</span> · {p.entities.length} table(s) · updated {fmtRelative(p.updatedAt)}
          </>
        }
        actions={
          <>
            <StatusBadge status={p.status} />
            {p.blockerCount > 0 && <StatusBadge status="BLOCKER" label={`${p.blockerCount} blocker(s)`} />}
            {p.warningCount > 0 && <StatusBadge status="WARNING" label={`${p.warningCount} warning(s)`} />}
            {p.lastRunId && (
              <Link to={`/runs/${p.lastRunId}`} className="text-xs font-medium text-brand-700 hover:underline">
                Latest run →
              </Link>
            )}
          </>
        }
      />
      <div className="mb-5">
        <Tabs
          value={step}
          onChange={setStep}
          tabs={[
            { value: 'tables', label: '3 · Tables' },
            { value: 'dependencies', label: '4 · Dependencies' },
            { value: 'mapping', label: '5 · Field mapping' },
            { value: 'review', label: '6 · Review & execute' },
          ]}
        />
      </div>
      {step === 'tables' && <TablesStep plan={p} onSaved={(np) => { setPlan(np); setStep('dependencies'); }} />}
      {step === 'dependencies' && <DependenciesStep plan={p} onNext={() => setStep('mapping')} />}
      {step === 'mapping' && <MappingStep plan={p} onPlan={setPlan} onNext={() => setStep('review')} />}
      {step === 'review' && <ReviewStep plan={p} onPlan={setPlan} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 3: tables
// ---------------------------------------------------------------------------

function TablesStep({ plan, onSaved }: { plan: MigrationPlanDto; onSaved: (p: MigrationPlanDto) => void }) {
  const [selected, setSelected] = useState(() => new Set(plan.entities.map((e) => e.logicalName)));
  const key = ['candidates', plan.sourceEnvironment.id, plan.targetEnvironment.id];
  const candidates = useQuery({
    queryKey: key,
    queryFn: () => get<TableCandidateDto[]>(`/api/migration/candidates${qs({ sourceEnvironmentId: plan.sourceEnvironment.id, targetEnvironmentId: plan.targetEnvironment.id })}`),
  });
  const save = useMutation({
    mutationFn: () => put<MigrationPlanDto>(`/api/plans/${plan.id}/tables`, { tables: [...selected] }),
    onSuccess: onSaved,
  });
  const order = useMemo(() => new Map(plan.entities.map((e) => [e.logicalName, e.orderIndex])), [plan.entities]);
  const changed = selected.size !== plan.entities.length || plan.entities.some((e) => !selected.has(e.logicalName));
  return (
    <Card
      title="Selected tables"
      subtitle="Changing the selection regenerates dependencies, mappings and issues. Manual mapping decisions are preserved."
      actions={
        <Button variant="primary" disabled={selected.size === 0} loading={save.isPending} onClick={() => save.mutate()}>
          {changed ? 'Save selection & regenerate plan' : 'Regenerate plan'}
        </Button>
      }
    >
      {save.error && <div className="mb-4"><ErrorState error={save.error} /></div>}
      {candidates.isLoading && <Spinner />}
      {candidates.error && <ErrorState error={candidates.error} />}
      {candidates.data && <TableSelector candidates={candidates.data} selected={selected} onChange={setSelected} order={order} queryKey={key} />}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 4: dependencies
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<DependencyEdgeDto['kind'], { label: string; tone: 'slate' | 'violet' | 'teal' | 'amber' | 'blue' | 'red' }> = {
  IN_SELECTION: { label: 'in plan', tone: 'blue' },
  SELF: { label: 'self', tone: 'violet' },
  PLATFORM: { label: 'platform (resolve in target)', tone: 'slate' },
  NOT_SELECTED: { label: 'not selected', tone: 'amber' },
  MISSING_IN_TARGET: { label: 'missing in target', tone: 'red' },
};

function EdgeList({ edges, direction }: { edges: DependencyEdgeDto[]; direction: 'out' | 'in' }) {
  if (edges.length === 0) return <span className="text-xs text-slate-400">None</span>;
  return (
    <ul className="space-y-1">
      {edges.map((e) => (
        <li key={`${e.from}.${e.attribute}.${e.to}`} className="text-xs">
          <span className="font-medium text-slate-800">{direction === 'out' ? e.to : e.from}</span> <span className="text-slate-400">via</span> <Mono>{direction === 'out' ? e.attribute : `${e.from}.${e.attribute}`}</Mono>{' '}
          <Pill tone={KIND_LABEL[e.kind].tone}>{KIND_LABEL[e.kind].label}</Pill> {e.required && <Pill tone="red">required</Pill>} {e.deferred && <Pill tone="violet">pass 2</Pill>}
        </li>
      ))}
    </ul>
  );
}

function DependenciesStep({ plan, onNext }: { plan: MigrationPlanDto; onNext: () => void }) {
  const analysis = plan.dependencyAnalysis;
  if (!analysis) return <EmptyState title="No dependency analysis" description="Regenerate the plan from the Tables step." />;
  const nodes = [...analysis.nodes].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  return (
    <div className="space-y-5">
      <Card title="Migration order" subtitle="Tables are migrated in dependency order computed with a topological sort of lookup relationships." actions={<Button variant="primary" onClick={onNext}>Continue: Map fields</Button>}>
        <ol className="flex flex-wrap items-center gap-2" data-testid="migration-order">
          {analysis.order.map((t, i) => {
            const node = analysis.nodes.find((n) => n.logicalName === t);
            return (
              <li key={t} className="flex items-center gap-2">
                <span className={cx('rounded-md border px-2.5 py-1 text-sm', node?.order ? 'border-slate-200 bg-white' : 'border-red-300 bg-red-50')}>
                  <span className="mr-1.5 text-xs font-semibold text-slate-400">{i + 1}</span>
                  {node?.displayName ?? t}
                  {node?.cycleGroup && <Pill tone="violet">cycle {node.cycleGroup}</Pill>}
                </span>
                {i < analysis.order.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-slate-400" />}
              </li>
            );
          })}
        </ol>
      </Card>

      {analysis.cycles.length > 0 && (
        <Card title="Circular dependencies" subtitle="Cycles are detected with strongly connected components and handled explicitly.">
          <div className="space-y-3">
            {analysis.cycles.map((c) => (
              <Callout key={c.group} tone={c.resolvable ? 'info' : 'danger'} title={`Cycle ${c.group}: ${c.tables.join(' ↔ ')}`}>
                {c.resolvable ? (
                  <>
                    <p>
                      <strong>Pass 1</strong> creates records without these optional lookups; <strong>pass 2</strong> sets them once all referenced records exist:
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {c.deferredEdges.map((e) => (
                        <li key={`${e.from}.${e.attribute}.${e.to}`}>
                          <Mono>
                            {e.from}.{e.attribute}
                          </Mono>{' '}
                          → {e.to}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  'This cycle consists of required lookups and cannot be handled automatically. Make one lookup optional in the target or migrate these tables separately.'
                )}
              </Callout>
            ))}
          </div>
        </Card>
      )}

      <Card title="Dependencies per table" bodyClassName="p-0">
        <Table>
          <thead className="bg-slate-50">
            <tr>
              <Th>#</Th>
              <Th>Table</Th>
              <Th>Depends on</Th>
              <Th>Dependents</Th>
              <Th>Cycle</Th>
              <Th>Warnings</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {nodes.map((n) => (
              <tr key={n.logicalName} data-testid={`dependency-node-${n.logicalName}`}>
                <Td className="tabular-nums text-slate-500">{n.order ?? '—'}</Td>
                <Td>
                  <div className="font-medium text-slate-900">{n.displayName}</div>
                  <Mono>{n.logicalName}</Mono>
                </Td>
                <Td><EdgeList edges={n.dependsOn} direction="out" /></Td>
                <Td><EdgeList edges={n.dependents} direction="in" /></Td>
                <Td>{n.cycleGroup ? <Pill tone="violet">cycle {n.cycleGroup}</Pill> : <span className="text-xs text-slate-400">No</span>}</Td>
                <Td className="max-w-sm text-xs text-amber-800">
                  {n.warnings.length === 0 ? <span className="text-slate-400">—</span> : <ul className="list-disc space-y-0.5 pl-4">{n.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5: mapping
// ---------------------------------------------------------------------------

interface MappingsResponse {
  entity: { id: string; logicalName: string; displayName: string };
  mappings: FieldMappingDto[];
  targetColumns: { logicalName: string; displayName: string; type: string; required: boolean; targets: string[] }[];
}
interface Suggestion {
  sourceField: string;
  targetField: string;
  confidence: number;
  rationale: string;
  provider: string;
}

function MappingStep({ plan, onPlan, onNext }: { plan: MigrationPlanDto; onPlan: (p: MigrationPlanDto) => void; onNext: () => void }) {
  const [entityId, setEntityId] = useState(plan.entities[0]?.id);
  const [statusFilter, setStatusFilter] = useState<'ALL' | MappingStatus>('ALL');
  const qc = useQueryClient();
  useEffect(() => {
    if (!plan.entities.some((e) => e.id === entityId)) setEntityId(plan.entities[0]?.id);
  }, [plan.entities, entityId]);
  const entity = plan.entities.find((e) => e.id === entityId);
  const mappings = useQuery({
    queryKey: ['mappings', plan.id, entityId],
    queryFn: () => get<MappingsResponse>(`/api/plans/${plan.id}/entities/${entityId}/mappings`),
    enabled: Boolean(entityId),
  });
  const suggestions = useMutation({ mutationFn: () => get<Suggestion[]>(`/api/plans/${plan.id}/entities/${entityId}/suggestions`) });
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const update = useMutation({
    mutationFn: (v: { mappingId: string; body: Record<string, unknown> }) => patch<MigrationPlanDto>(`/api/plans/${plan.id}/mappings/${v.mappingId}`, v.body),
    onSuccess: (np) => {
      onPlan(np);
      void qc.invalidateQueries({ queryKey: ['mappings', plan.id] });
    },
  });
  const updateEntity = useMutation({
    mutationFn: (body: { matchStrategy: 'PRIMARY_ID' | 'ALTERNATE_KEY'; alternateKey: string | null }) => patch<MigrationPlanDto>(`/api/plans/${plan.id}/entities/${entityId}`, body),
    onSuccess: onPlan,
  });

  if (plan.entities.length === 0) return <EmptyState title="No tables in this plan" />;
  const rows = (mappings.data?.mappings ?? []).filter((m) => statusFilter === 'ALL' || m.status === statusFilter);
  const openSuggestions = (suggestions.data ?? []).filter((s) => !dismissed.has(s.sourceField + s.targetField));

  return (
    <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
      <Card title="Tables" bodyClassName="p-2">
        <ul className="space-y-0.5">
          {plan.entities.map((e) => {
            const attention = e.mappingSummary.UNMAPPED + e.mappingSummary.INCOMPATIBLE;
            return (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => {
                    setEntityId(e.id);
                    suggestions.reset();
                  }}
                  className={cx('flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm', e.id === entityId ? 'bg-brand-50 text-brand-800' : 'hover:bg-slate-50')}
                >
                  <span className="truncate">{e.displayName}</span>
                  {attention > 0 ? <Pill tone="amber">{attention}</Pill> : <Pill tone="teal">ok</Pill>}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
      <div className="space-y-5">
        {entity && (
          <Card
            title={`${entity.displayName} — record matching`}
            subtitle="How existing target records are identified (prevents duplicates)."
            actions={<Button variant="primary" onClick={onNext}>Continue: Review plan</Button>}
          >
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Select
                label="Match strategy"
                value={entity.matchStrategy === 'ALTERNATE_KEY' ? `KEY:${entity.alternateKey}` : 'PRIMARY_ID'}
                disabled={updateEntity.isPending}
                onChange={(v) =>
                  updateEntity.mutate(v === 'PRIMARY_ID' ? { matchStrategy: 'PRIMARY_ID', alternateKey: null } : { matchStrategy: 'ALTERNATE_KEY', alternateKey: v.slice(4) })
                }
                options={[
                  { value: 'PRIMARY_ID', label: 'Match by primary ID (preserve GUIDs)' },
                  ...entity.availableKeys.map((k) => ({ value: `KEY:${k.logicalName}`, label: `Match by alternate key ${k.logicalName} (${k.attributes.join(', ')})` })),
                ]}
              />
              {entity.availableKeys.length === 0 && <span className="text-xs text-slate-500">No alternate keys are defined in the target for this table.</span>}
            </div>
            {updateEntity.error && <div className="mt-3"><ErrorState error={updateEntity.error} /></div>}
          </Card>
        )}
        <Card
          title="Field mapping"
          subtitle="Deterministic auto-mapping by logical name and compatible type. Suggestions are never applied without your confirmation."
          actions={
            <>
              <Select
                label="Filter by status"
                value={statusFilter}
                onChange={(v) => setStatusFilter(v as typeof statusFilter)}
                options={['ALL', 'AUTO_MAPPED', 'MANUAL', 'UNMAPPED', 'INCOMPATIBLE', 'IGNORED'].map((s) => ({ value: s, label: s === 'ALL' ? 'All statuses' : s.replace('_', ' ').toLowerCase() }))}
              />
              <Button icon={<Lightbulb className="h-4 w-4" />} loading={suggestions.isPending} onClick={() => suggestions.mutate()}>
                Suggest mappings
              </Button>
            </>
          }
          bodyClassName="p-0"
        >
          {suggestions.data && (
            <div className="border-b border-slate-100 p-4">
              {openSuggestions.length === 0 ? (
                <p className="text-sm text-slate-500">No suggestions for the remaining unmapped columns.</p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Suggestions — review before accepting</p>
                  {openSuggestions.map((s) => {
                    const m = mappings.data?.mappings.find((x) => x.sourceField === s.sourceField);
                    return (
                      <div key={s.sourceField + s.targetField} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                        <span>
                          <Mono>{s.sourceField}</Mono> → <Mono>{s.targetField}</Mono> <span className="text-xs text-slate-600">({s.confidence}% · {s.rationale})</span>
                        </span>
                        <span className="flex gap-2">
                          <Button size="sm" variant="primary" disabled={!m} loading={update.isPending} onClick={() => m && update.mutate({ mappingId: m.id, body: { action: 'MAP', targetField: s.targetField } })}>
                            Accept
                          </Button>
                          <Button size="sm" onClick={() => setDismissed(new Set([...dismissed, s.sourceField + s.targetField]))}>
                            Dismiss
                          </Button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {update.error && <div className="p-4"><ErrorState error={update.error} /></div>}
          {mappings.isLoading && <Spinner />}
          {mappings.error && <div className="p-4"><ErrorState error={mappings.error} /></div>}
          {mappings.data && (
            <Table>
              <thead className="bg-slate-50">
                <tr>
                  <Th>Source field</Th>
                  <Th>Target field</Th>
                  <Th>Types</Th>
                  <Th>Status</Th>
                  <Th>Confidence / reason</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((m) => (
                  <tr key={m.id} data-testid={`mapping-${m.sourceField}`}>
                    <Td>
                      <div className="text-slate-900">{m.sourceDisplayName}</div>
                      <Mono>{m.sourceField}</Mono>
                      {m.isLookup && <div className="text-[11px] text-slate-500">lookup → {m.lookupTargets.join(', ')}</div>}
                      {m.deferredTargets.length > 0 && <Pill tone="violet">pass 2: {m.deferredTargets.join(', ')}</Pill>}
                    </Td>
                    <Td>
                      <select
                        aria-label={`Target for ${m.sourceField}`}
                        value={m.targetField && (m.status === 'AUTO_MAPPED' || m.status === 'MANUAL') ? m.targetField : ''}
                        disabled={update.isPending}
                        onChange={(e) => e.target.value && update.mutate({ mappingId: m.id, body: { action: 'MAP', targetField: e.target.value } })}
                        className="max-w-[220px] rounded border border-slate-300 bg-white py-1 pl-2 pr-7 text-xs"
                      >
                        <option value="">— not mapped —</option>
                        {mappings.data.targetColumns.map((c) => (
                          <option key={c.logicalName} value={c.logicalName}>
                            {c.displayName} ({c.logicalName}) · {c.type}
                            {c.required ? ' · required' : ''}
                          </option>
                        ))}
                      </select>
                    </Td>
                    <Td className="text-xs text-slate-600">
                      {m.sourceType} → {m.targetType ?? '—'}
                    </Td>
                    <Td><StatusBadge status={m.status} /></Td>
                    <Td className="max-w-xs text-xs text-slate-600">
                      <span className="font-medium tabular-nums">{m.confidence}%</span> · {m.reason}
                    </Td>
                    <Td className="whitespace-nowrap text-right">
                      <div className="flex justify-end gap-1">
                        {m.status !== 'IGNORED' && (
                          <Button size="sm" variant="ghost" onClick={() => update.mutate({ mappingId: m.id, body: { action: 'IGNORE' } })}>
                            Ignore
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3 w-3" />} onClick={() => update.mutate({ mappingId: m.id, body: { action: 'RESET' } })}>
                          Reset
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <Td colSpan={6} className="py-6 text-center text-slate-500">
                      No mappings with this status.
                    </Td>
                  </tr>
                )}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 6: review & execute
// ---------------------------------------------------------------------------

interface SettingsResponse {
  safety: { businessLogicBypassAllowed: boolean; canBypass: boolean };
}

function IssueList({ issues }: { issues: PlanIssue[] }) {
  const groups: PlanIssue['severity'][] = ['BLOCKER', 'WARNING', 'INFO'];
  if (issues.length === 0) return <Callout tone="success" title="No issues found" />;
  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const list = issues.filter((i) => i.severity === g);
        if (!list.length) return null;
        return (
          <div key={g}>
            <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <StatusBadge status={g} /> {list.length}
            </h4>
            <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
              {list.map((i, idx) => (
                <li key={`${i.code}-${i.table}-${i.field}-${idx}`} className="px-3 py-2 text-sm" data-testid={`issue-${g}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    {i.table && <Pill tone="blue">{i.table}</Pill>}
                    <Mono className="text-[11px] text-slate-400">{i.code}</Mono>
                  </div>
                  <p className="mt-0.5 text-slate-800">{i.message}</p>
                  {i.resolution && <p className="text-xs text-slate-500">{i.resolution}</p>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function ReviewStep({ plan, onPlan }: { plan: MigrationPlanDto; onPlan: (p: MigrationPlanDto) => void }) {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsResponse>('/api/settings') });
  const options = useMutation({ mutationFn: (patchBody: Partial<PlanOptions>) => patch<MigrationPlanDto>(`/api/plans/${plan.id}/options`, patchBody), onSuccess: onPlan });
  const revalidate = useMutation({ mutationFn: () => post<MigrationPlanDto>(`/api/plans/${plan.id}/revalidate`), onSuccess: onPlan });
  const o = plan.options;
  const totalSource = plan.entities.reduce((n, e) => n + (e.sourceCount ?? 0), 0);

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Plan summary" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--color-source)]">Source</dt>
              <dd className="font-medium">{plan.sourceEnvironment.displayName}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--color-target)]">Target</dt>
              <dd className="font-medium">{plan.targetEnvironment.displayName}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Tables</dt>
              <dd className="font-medium">{plan.entities.length}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Source records</dt>
              <dd className="font-medium tabular-nums">{fmtNumber(totalSource)}</dd>
            </div>
          </dl>
          <div className="mt-5 overflow-x-auto">
            <Table className="rounded-md border border-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <Th>#</Th>
                  <Th>Table</Th>
                  <Th className="text-right">Source</Th>
                  <Th className="text-right">Target</Th>
                  <Th>Schema</Th>
                  <Th>Matching</Th>
                  <Th>Mapping</Th>
                  <Th>Server-side logic</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {plan.entities.map((e: PlanEntityDto) => (
                  <tr key={e.id}>
                    <Td className="tabular-nums text-slate-500">{e.orderIndex}</Td>
                    <Td>
                      <div className="font-medium text-slate-900">{e.displayName}</div>
                      {e.category && <Pill tone="teal">{e.category.toLowerCase()}</Pill>} {e.cycleGroup && <Pill tone="violet">cycle {e.cycleGroup}</Pill>}
                    </Td>
                    <Td className="text-right tabular-nums">{fmtNumber(e.sourceCount)}</Td>
                    <Td className="text-right tabular-nums">{fmtNumber(e.targetCount)}</Td>
                    <Td><StatusBadge status={e.schemaStatus} /></Td>
                    <Td className="text-xs">{e.matchStrategy === 'ALTERNATE_KEY' ? `Key: ${e.alternateKey}` : 'Primary ID'}</Td>
                    <Td className="text-xs text-slate-600">
                      {e.mappingSummary.AUTO_MAPPED + e.mappingSummary.MANUAL} mapped
                      {e.mappingSummary.UNMAPPED > 0 && <span className="text-amber-700"> · {e.mappingSummary.UNMAPPED} unmapped</span>}
                      {e.mappingSummary.INCOMPATIBLE > 0 && <span className="text-red-700"> · {e.mappingSummary.INCOMPATIBLE} incompatible</span>}
                    </Td>
                    <Td className="text-xs">
                      {!e.automation ? '—' : !e.automation.detectionSupported ? <span className="text-slate-500">Unknown</span> : e.automation.pluginSteps + e.automation.workflows + e.automation.flows === 0 ? <span className="text-slate-500">None detected</span> : (
                        <span className="text-amber-700" title={e.automation.details.join('\n')}>
                          {e.automation.pluginSteps} plug-in · {e.automation.workflows} workflow · {e.automation.flows} flow
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>

        <Card title="Execution options">
          <fieldset className="space-y-2" disabled={options.isPending}>
            <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Existing records in target</legend>
            {(
              [
                ['SKIP_EXISTING', 'Skip existing (safest)', 'Create missing records; never modify records that already exist.'],
                ['CREATE_ONLY', 'Create only', 'Create records; matching existing records are reported as failures.'],
                ['UPSERT', 'Upsert', 'Create missing records and overwrite mapped columns on existing ones.'],
              ] as [ConflictStrategy, string, string][]
            ).map(([value, label, help]) => (
              <label key={value} className="flex cursor-pointer gap-2 rounded-md border border-slate-200 p-2 text-sm has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                <input type="radio" name="conflict" value={value} checked={o.conflictStrategy === value} onChange={() => options.mutate({ conflictStrategy: value })} className="mt-0.5" />
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="block text-xs text-slate-500">{help}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="mt-4 space-y-3 text-sm">
            <label className="flex items-center justify-between gap-2">
              <span>Batch size</span>
              <select aria-label="Batch size" value={o.batchSize} onChange={(e) => options.mutate({ batchSize: Number(e.target.value) })} className="rounded border border-slate-300 py-1 pl-2 pr-7 text-sm">
                {[10, 25, 50, 100, 250].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={o.stopOnFirstError} onChange={(e) => options.mutate({ stopOnFirstError: e.target.checked })} />
              Stop the run on the first record failure
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={o.suppressFlowTriggers} onChange={(e) => options.mutate({ suppressFlowTriggers: e.target.checked })} />
              Suppress Power Automate flow triggers
            </label>
            <div className="rounded-md border border-slate-200 p-2">
              <label className={cx('flex items-center gap-2', !settings.data?.safety.canBypass && 'text-slate-400')}>
                <input
                  type="checkbox"
                  checked={o.bypassCustomBusinessLogic}
                  disabled={!settings.data?.safety.canBypass}
                  onChange={(e) => options.mutate({ bypassCustomBusinessLogic: e.target.checked })}
                />
                <ShieldAlert className="h-4 w-4" /> Bypass custom plug-ins (audited)
              </label>
              <p className="mt-1 text-xs text-slate-500">
                {settings.data?.safety.canBypass
                  ? 'Sends MSCRM.BypassBusinessLogicExecution. Requires the prvBypassCustomBusinessLogic privilege in the target.'
                  : 'Disabled: requires ALLOW_BUSINESS_LOGIC_BYPASS=true and the administrator role. Plug-ins are never disabled globally.'}
              </p>
            </div>
          </div>
          {options.error && <div className="mt-3"><ErrorState error={options.error} /></div>}
        </Card>
      </div>

      <Card
        title="Issues"
        subtitle="Execution is blocked while any BLOCKER remains. Warnings must be acknowledged."
        actions={
          <Button icon={<RefreshCw className="h-4 w-4" />} loading={revalidate.isPending} onClick={() => revalidate.mutate()}>
            Re-validate plan
          </Button>
        }
      >
        {revalidate.error && <div className="mb-3"><ErrorState error={revalidate.error} /></div>}
        <IssueList issues={plan.issues} />
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        {plan.blockerCount > 0 ? (
          <span className="text-sm text-red-700">Resolve {plan.blockerCount} blocker(s) before executing.</span>
        ) : (
          <span className="text-sm text-slate-600">
            Ready to execute against <strong className="text-[var(--color-target)]">{plan.targetEnvironment.displayName}</strong>.
          </span>
        )}
        <Button variant="primary" icon={<Play className="h-4 w-4" />} disabled={plan.blockerCount > 0 || plan.entities.length === 0} onClick={() => setConfirmOpen(true)}>
          Execute migration
        </Button>
      </div>
      <ExecuteModal plan={plan} open={confirmOpen} onClose={() => setConfirmOpen(false)} onStarted={(run) => navigate(`/runs/${run.id}`)} />
    </div>
  );
}

function ExecuteModal({ plan, open, onClose, onStarted }: { plan: MigrationPlanDto; open: boolean; onClose: () => void; onStarted: (r: MigrationRunDto) => void }) {
  const [typed, setTyped] = useState('');
  const [ack, setAck] = useState(false);
  const execute = useMutation({
    mutationFn: () =>
      post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
        confirmSourceName: plan.sourceEnvironment.displayName,
        confirmTargetName: typed,
        acknowledgeWarnings: ack,
      }),
    onSuccess: onStarted,
  });
  const totalSource = plan.entities.reduce((n, e) => n + (e.sourceCount ?? 0), 0);
  const canRun = typed.trim() === plan.targetEnvironment.displayName && (plan.warningCount === 0 || ack);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Confirm migration execution"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!canRun} loading={execute.isPending} onClick={() => execute.mutate()}>
            Write data to {plan.targetEnvironment.displayName}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div className="rounded-md border-l-4 border-l-[var(--color-source)] bg-slate-50 p-3">
            <div className="text-[10px] font-bold tracking-widest text-[var(--color-source)]">SOURCE (read)</div>
            <div className="font-semibold">{plan.sourceEnvironment.displayName}</div>
            <div className="truncate font-mono text-[11px] text-slate-500">{plan.sourceEnvironment.url}</div>
          </div>
          <ArrowRight className="h-5 w-5 text-slate-400" />
          <div className="rounded-md border-l-4 border-l-[var(--color-target)] bg-slate-50 p-3">
            <div className="text-[10px] font-bold tracking-widest text-[var(--color-target)]">TARGET (write)</div>
            <div className="font-semibold">{plan.targetEnvironment.displayName}</div>
            <div className="truncate font-mono text-[11px] text-slate-500">{plan.targetEnvironment.url}</div>
          </div>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-slate-700">
          <li>
            {plan.entities.length} table(s), up to {fmtNumber(totalSource)} source record(s), in dependency order.
          </li>
          <li>
            Existing records: <strong>{plan.options.conflictStrategy.replace('_', ' ').toLowerCase()}</strong>.
          </li>
          {plan.options.bypassCustomBusinessLogic && <li className="text-red-700">Custom plug-ins will be bypassed (audited).</li>}
          <li>Records are written with your delegated permissions; failures are recorded without stopping the run{plan.options.stopOnFirstError ? ' (except: stop on first error is enabled)' : ''}.</li>
        </ul>
        {plan.warningCount > 0 && (
          <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" data-testid="ack-warnings" />
            I reviewed the {plan.warningCount} warning(s) in this plan and want to proceed.
          </label>
        )}
        <div>
          <label htmlFor="confirm-target" className="block text-xs font-medium text-slate-600">
            Type the target environment name <strong>{plan.targetEnvironment.displayName}</strong> to confirm
          </label>
          <input
            id="confirm-target"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
        {execute.error && <ErrorState error={execute.error} />}
      </div>
    </Modal>
  );
}
