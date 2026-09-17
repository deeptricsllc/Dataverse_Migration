import type {
  EnvRef,
  JobRunStatus,
  MigrationRunListItemDto,
  TableCandidateDto,
  ValidationOutcome,
  ValidationRunDto,
  ValidationSummary,
} from '@shared/domain';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, EmptyState, ErrorState, PageHeader, Select, Spinner } from '../components/ui';
import { get, post, qs } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useWorkspace } from '../lib/session';
import { ValidationTable } from './RunsPage';

export interface ValidationListItem {
  id: string;
  status: JobRunStatus;
  outcome: ValidationOutcome | null;
  migrationRunId: string | null;
  sourceEnvironment: EnvRef;
  targetEnvironment: EnvRef;
  tableCount: number;
  summary: ValidationSummary | null;
  createdAt: string;
  completedAt: string | null;
  createdBy: string | null;
}

export function ValidationPage() {
  const navigate = useNavigate();
  const { source, target, ready } = useWorkspace();
  const validations = useQuery({
    queryKey: ['validations'],
    queryFn: () => get<ValidationListItem[]>('/api/validations'),
    refetchInterval: 5000,
  });
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => get<MigrationRunListItemDto[]>('/api/runs') });
  const candidates = useQuery({
    queryKey: ['candidates', source?.id, target?.id],
    queryFn: () =>
      get<TableCandidateDto[]>(
        `/api/migration/candidates${qs({ sourceEnvironmentId: source?.id, targetEnvironmentId: target?.id })}`,
      ),
    enabled: ready,
  });
  const finishedRuns = (runs.data ?? []).filter((r) =>
    ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'].includes(r.status),
  );
  const [runId, setRunId] = useState('');
  const [tables, setTables] = useState<Set<string>>(new Set());

  const start = useMutation({
    mutationFn: (body: Record<string, unknown>) => post<ValidationRunDto>('/api/validations', body),
    onSuccess: (v) => navigate(`/validation/${v.id}`),
  });
  const effectiveRunId = runId || finishedRuns[0]?.id || '';
  const tableOptions = (candidates.data ?? []).filter(
    (c) => c.schemaStatus && c.schemaStatus !== 'SOURCE_ONLY',
  );

  return (
    <>
      <PageHeader
        title="Validation"
        description="Verify target data against the source: schema, row counts, record existence, field values and lookup references."
      />
      {start.error && (
        <div className="mb-4">
          <ErrorState error={start.error} />
        </div>
      )}
      <div className="mb-6 grid gap-5 lg:grid-cols-2">
        <Card
          title="Validate a migration run"
          subtitle="Uses the run’s record identity map for exact record-by-record comparison."
        >
          {runs.isLoading && <Spinner />}
          {finishedRuns.length === 0 && !runs.isLoading && (
            <p className="text-sm text-slate-500">No finished migration runs yet.</p>
          )}
          {finishedRuns.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <Select
                label="Migration run"
                value={effectiveRunId}
                onChange={setRunId}
                className="max-w-full"
                options={finishedRuns.map((r) => ({
                  value: r.id,
                  label: `${r.planName} · ${r.status.toLowerCase()} · ${fmtDate(r.createdAt)}`,
                }))}
              />
              <Button
                variant="primary"
                icon={<ShieldCheck className="h-4 w-4" />}
                loading={start.isPending}
                disabled={!effectiveRunId}
                onClick={() => start.mutate({ migrationRunId: effectiveRunId })}
              >
                Validate run
              </Button>
            </div>
          )}
        </Card>
        <Card
          title="Validate environment tables"
          subtitle={
            ready
              ? `${source!.displayName} → ${target!.displayName}: compares records by identifier (sampled).`
              : 'Select a source and target first.'
          }
        >
          {!ready && <Button onClick={() => navigate('/environments')}>Select environments</Button>}
          {ready && candidates.isLoading && <Spinner />}
          {ready && candidates.data && tableOptions.length === 0 && (
            <p className="text-sm text-slate-500">Analyze the environments first to choose tables.</p>
          )}
          {ready && tableOptions.length > 0 && (
            <>
              <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                {tableOptions.map((t) => (
                  <label
                    key={t.logicalName}
                    className="flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={tables.has(t.logicalName)}
                      onChange={(e) => {
                        const next = new Set(tables);
                        if (e.target.checked) next.add(t.logicalName);
                        else next.delete(t.logicalName);
                        setTables(next);
                      }}
                    />
                    {t.displayName}
                  </label>
                ))}
              </div>
              <Button
                className="mt-3"
                icon={<ShieldCheck className="h-4 w-4" />}
                disabled={tables.size === 0}
                loading={start.isPending}
                onClick={() =>
                  start.mutate({
                    sourceEnvironmentId: source!.id,
                    targetEnvironmentId: target!.id,
                    tables: [...tables],
                  })
                }
              >
                Validate {tables.size} table(s)
              </Button>
            </>
          )}
        </Card>
      </div>
      <Card title="Validation history" bodyClassName="p-0">
        {validations.isLoading && <Spinner />}
        {validations.error && (
          <div className="p-4">
            <ErrorState error={validations.error} />
          </div>
        )}
        {validations.data?.length === 0 && (
          <EmptyState icon={<ShieldCheck className="h-8 w-8" />} title="No validation runs yet" />
        )}
        {validations.data && validations.data.length > 0 && (
          <ValidationTable items={validations.data} onOpen={(id) => navigate(`/validation/${id}`)} />
        )}
      </Card>
    </>
  );
}
