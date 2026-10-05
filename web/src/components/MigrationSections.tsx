import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type {
  FieldMappingDto,
  MigrationPlanDto,
  MigrationRunStatus,
  MigrationWorkspaceDto,
} from '@shared/domain';
import { Card, EmptyState, ErrorState, Pill, Spinner } from './ui';
import { DependenciesStep, MappingStep } from '../pages/PlanPage';
import { api } from '../lib/api';
import { describeCount, fmtRelative } from '../lib/format';

/**
 * The sections of a migration workspace that work on its configuration.
 *
 * Mapping and dependencies are rendered by the components that already did it, without their "Continue"
 * buttons — a section has nothing to continue to. §35 is explicit that mature engine and UI code should
 * not be rewritten because the navigation changed, and the mapping screen in particular carries years of
 * accumulated correctness about suggestions, choice mapping and record matching.
 *
 * What is new here is the two things the wizard had nowhere to put: a read-across of every transformation
 * configured anywhere in the migration, and the run history as something you return to rather than a page
 * you were sent to once.
 */

/** Loads the project's current configuration, which every section below works on. */
function useCurrentPlan(projectId: string) {
  return useQuery({
    queryKey: ['migration-plan', projectId],
    queryFn: () => api<MigrationPlanDto | null>('GET', `/api/projects/${projectId}/migration/plan`),
  });
}

function NothingConfigured({ what }: { what: string }) {
  return (
    <Card>
      <EmptyState title={`No data to ${what}`} description="Add source data and select a target." />
    </Card>
  );
}

export function MigrationMapping({ w }: { w: MigrationWorkspaceDto }) {
  const queryClient = useQueryClient();
  const plan = useCurrentPlan(w.projectId);
  if (plan.isLoading) return <Spinner label="Loading the mapping…" />;
  if (plan.error) return <ErrorState error={plan.error} />;
  if (!plan.data || plan.data.entities.length === 0) return <NothingConfigured what="map" />;
  return (
    <MappingStep
      plan={plan.data}
      onPlan={() => {
        void queryClient.invalidateQueries({ queryKey: ['migration-plan', w.projectId] });
        void queryClient.invalidateQueries({ queryKey: ['migration-workspace', w.projectId] });
      }}
    />
  );
}

export function MigrationDependencies({ w }: { w: MigrationWorkspaceDto }) {
  const plan = useCurrentPlan(w.projectId);
  if (plan.isLoading) return <Spinner label="Loading the dependency analysis…" />;
  if (plan.error) return <ErrorState error={plan.error} />;
  if (!plan.data || plan.data.entities.length === 0) return <NothingConfigured what="order" />;
  return <DependenciesStep plan={plan.data} />;
}

/**
 * Every transformation configured anywhere in this migration, in one list.
 *
 * §13: a consultant must be able to answer "what will happen to this field before it reaches the target"
 * without opening every field mapping in turn. Editing still happens beside the field it belongs to —
 * this is the read-across, which is the thing the wizard had nowhere to put.
 */
export function MigrationTransformations({ w }: { w: MigrationWorkspaceDto }) {
  const plan = useCurrentPlan(w.projectId);
  const entities = plan.data?.entities ?? [];

  const transformed = useQuery({
    queryKey: ['migration-transformations', w.projectId, entities.map((e) => e.id).join(',')],
    enabled: entities.length > 0,
    queryFn: async () => {
      const rows: {
        entity: string;
        sourceField: string;
        targetField: string;
        rules: string[];
      }[] = [];
      for (const entity of entities) {
        const response = await api<{ mappings: FieldMappingDto[] }>(
          'GET',
          `/api/plans/${plan.data!.id}/entities/${entity.id}/mappings`,
        );
        for (const m of response.mappings) {
          // An empty pipeline is a direct copy, which is not a transformation and is not listed as one.
          if (!m.targetField || m.transformations.length === 0) continue;
          rows.push({
            entity: entity.logicalName,
            sourceField: m.sourceField,
            targetField: m.targetField,
            rules: m.transformations.map((t) => t.kind),
          });
        }
      }
      return rows;
    },
  });

  if (plan.isLoading) return <Spinner label="Loading the configuration…" />;
  if (!plan.data || entities.length === 0) return <NothingConfigured what="transform" />;

  return (
    <Card
      title="Transformations"
      subtitle="Edit a transformation under Mapping, beside the field it applies to."
      data-testid="transformations-list"
      bodyClassName="p-0"
    >
      {transformed.isLoading && (
        <div className="p-5">
          <Spinner label="Reading the field mappings…" />
        </div>
      )}
      {transformed.error && (
        <div className="p-5">
          <ErrorState error={transformed.error} />
        </div>
      )}
      {transformed.data && transformed.data.length === 0 && (
        <div className="p-5">
          <EmptyState title="No transformations" description="Every mapped field is written as it is read." />
        </div>
      )}
      {transformed.data && transformed.data.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {transformed.data.map((row) => (
            <li
              key={`${row.entity}.${row.sourceField}`}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
              data-testid="transformation-row"
            >
              <span className="w-40 flex-none truncate text-xs text-slate-500">{row.entity}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-800">
                {row.sourceField}
              </span>
              <span className="flex-none text-slate-300">→</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-800">
                {row.targetField}
              </span>
              <span className="flex flex-none flex-wrap gap-1">
                {row.rules.map((rule) => (
                  <Pill key={rule} tone="violet">
                    {rule.toLowerCase().replace(/_/g, ' ')}
                  </Pill>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

interface RunRow {
  id: string;
  status: MigrationRunStatus;
  attempt: number;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  unresolved: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * Every run this migration has had.
 *
 * §22: a retry never makes the original run look as though it quietly changed. A retry re-queues the same
 * run as a further attempt — which is why the attempt is on the row — and running the configuration again
 * produces a new run with its own number. Both are history, and neither overwrites the other.
 */
export function MigrationRuns({ w }: { w: MigrationWorkspaceDto }) {
  const runs = useQuery({
    queryKey: ['migration-runs', w.projectId],
    queryFn: () => api<RunRow[]>('GET', `/api/projects/${w.projectId}/migration/runs`),
    refetchInterval: w.status === 'RUNNING' ? 4000 : false,
  });

  if (runs.isLoading) return <Spinner label="Loading the run history…" />;
  if (runs.error) return <ErrorState error={runs.error} />;
  const rows = runs.data ?? [];

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState title="No runs" description="Run the migration to see results here." />
      </Card>
    );
  }

  return (
    <Card
      title={describeCount(rows.length, 'run')}
      subtitle="Newest first. A retry adds an attempt to a run. Running again creates a new run."
      data-testid="migration-runs"
      bodyClassName="p-0"
    >
      <ul className="divide-y divide-slate-100">
        {rows.map((run, i) => (
          <li key={run.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="run-row">
            <span className="w-16 flex-none text-sm font-semibold text-slate-900">#{rows.length - i}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-900">{RUN_LABELS[run.status]}</p>
              <p className="text-xs text-slate-500">
                {run.startedAt ? fmtRelative(run.startedAt) : 'not started'}
                {/* The attempt, so a retry never looks like the first run changed its mind. */}
                {run.attempt > 1 && ` · attempt ${run.attempt}`}
              </p>
            </div>
            <p className="flex-none text-right text-xs tabular-nums text-slate-600">
              {run.succeeded.toLocaleString()} succeeded
              {run.failed > 0 && (
                <span className="block text-red-700">{run.failed.toLocaleString()} failed</span>
              )}
              {run.unresolved > 0 && (
                <span className="block text-amber-700">{run.unresolved.toLocaleString()} unresolved</span>
              )}
            </p>
            <Link to={`/runs/${run.id}`} className="flex-none text-sm text-brand-700 hover:underline">
              Open →
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const RUN_LABELS: Record<MigrationRunStatus, string> = {
  DRAFT: 'Draft',
  PLANNED: 'Planned',
  QUEUED: 'Queued',
  RUNNING: 'Running',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  COMPLETED_WITH_ERRORS: 'Completed with issues',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  NEEDS_RECONCILIATION: 'Needs reconciliation',
};
