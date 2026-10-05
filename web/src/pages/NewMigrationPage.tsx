import type { MigrationPlanDto, ProjectDto, TableCandidateDto } from '@shared/domain';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TableSelector } from '../components/TableSelector';
import { Button, Callout, Card, EmptyState, ErrorState, PageHeader, Spinner } from '../components/ui';
import { get, post, qs } from '../lib/api';

export function NewMigrationPage() {
  const navigate = useNavigate();
  /**
   * The plan's two ends come from the migration project that owns them.
   *
   * They used to come from a global, per-user "current source and target" — which is why Connections had
   * "Set as source" buttons, why a source → target strip hung over every page, and why starting a
   * migration meant going to Connections first. A migration's two ends belong to that migration, so they
   * are read from the project here and nowhere else.
   */
  const [params] = useSearchParams();
  const projectId = params.get('projectId');
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => get<ProjectDto>(`/api/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const source = project.data?.sourceEnvironment ?? null;
  const target = project.data?.targetEnvironment ?? null;
  const ready = Boolean(source && target);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const key = ['candidates', source?.id, target?.id];
  const candidates = useQuery({
    queryKey: key,
    queryFn: () =>
      get<TableCandidateDto[]>(
        `/api/migration/candidates${qs({ sourceEnvironmentId: source?.id, targetEnvironmentId: target?.id })}`,
      ),
    enabled: ready,
  });
  const create = useMutation({
    mutationFn: () =>
      post<MigrationPlanDto>('/api/plans', {
        name: name || undefined,
        sourceEnvironmentId: source!.id,
        targetEnvironmentId: target!.id,
        tables: [...selected],
        projectId,
      }),
    onSuccess: (plan) => navigate(`/migration/plans/${plan.id}?step=dependencies`),
  });

  if (!projectId) {
    return (
      <EmptyState
        title="Start from a migration project"
        description="A migration needs a source and a target. Create a migration project and select them there."
        action={
          <Button variant="primary" onClick={() => navigate('/projects')}>
            Go to Projects
          </Button>
        }
      />
    );
  }
  if (project.isLoading) return <Spinner label="Loading the migration…" />;
  if (!ready) {
    return (
      <EmptyState
        title="This migration needs a source and a target"
        description="Choose the system the data comes from and the system it goes to, on the migration project."
        action={
          <Button variant="primary" onClick={() => navigate(`/projects/${projectId}`)}>
            Open the migration project
          </Button>
        }
      />
    );
  }
  const analyzed = candidates.data?.some((c) => c.schemaStatus && c.sourceCount !== null);

  return (
    <>
      <PageHeader
        title="Select tables to migrate"
        description="Select the tables to copy from the source to the target. Record counts are from the last analysis. Dependencies are shown but not selected automatically."
        actions={
          <Button
            variant="primary"
            disabled={selected.size === 0}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Generate migration plan ({selected.size})
          </Button>
        }
      />
      {candidates.data && !analyzed && (
        <div className="mb-4">
          <Callout tone="info" title="Analyze the environments first for schema status and record counts">
            <button type="button" className="font-medium underline" onClick={() => navigate('/compare')}>
              Go to Compare
            </button>
          </Callout>
        </div>
      )}
      {create.error && (
        <div className="mb-4">
          <ErrorState error={create.error} />
        </div>
      )}
      <Card>
        <div className="mb-4 max-w-md">
          <label htmlFor="plan-name" className="block text-xs font-medium text-slate-600">
            Plan name (optional)
          </label>
          <input
            id="plan-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${source!.displayName} → ${target!.displayName}`}
            maxLength={200}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
        {candidates.isLoading && <Spinner label="Loading tables and record counts…" />}
        {candidates.error && <ErrorState error={candidates.error} onRetry={() => candidates.refetch()} />}
        {candidates.data && (
          <TableSelector
            candidates={candidates.data}
            selected={selected}
            onChange={setSelected}
            queryKey={key}
          />
        )}
      </Card>
    </>
  );
}
