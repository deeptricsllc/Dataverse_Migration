import type { MigrationPlanDto, TableCandidateDto } from '@shared/domain';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TableSelector } from '../components/TableSelector';
import { WizardSteps } from '../components/WizardSteps';
import { Button, Callout, Card, EmptyState, ErrorState, PageHeader, Spinner } from '../components/ui';
import { get, post, qs } from '../lib/api';
import { useWorkspace } from '../lib/session';

export function NewMigrationPage() {
  const navigate = useNavigate();
  const { source, target, ready } = useWorkspace();
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
      }),
    onSuccess: (plan) => navigate(`/migration/plans/${plan.id}?step=dependencies`),
  });

  if (!ready) {
    return (
      <>
        <WizardSteps current={3} links={{ 1: '/environments' }} />
        <EmptyState
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
  const analyzed = candidates.data?.some((c) => c.schemaStatus && c.sourceCount !== null);

  return (
    <>
      <WizardSteps current={3} links={{ 1: '/environments', 2: '/compare' }} />
      <PageHeader
        title="Select tables to migrate"
        description="Choose the tables whose data should be copied from the source to the target. Record counts are as of the last analysis; the plan refreshes them. Dependencies are shown but never selected automatically."
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
