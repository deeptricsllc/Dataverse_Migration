import type { MigrationPlanDto, ObjectMappingStatus, PlanEntityDto } from '@shared/domain';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Check } from 'lucide-react';
import { Button, Callout, Card, ErrorState, Mono, Pill, Select, Spinner } from './ui';
import { get, patch } from '../lib/api';

interface TargetCandidates {
  current: string | null;
  status: ObjectMappingStatus;
  candidates: { logicalName: string; displayName: string; confidence: number; reason: string }[];
  allTargets: { logicalName: string; displayName: string }[];
}

const TONE: Record<ObjectMappingStatus, 'teal' | 'amber' | 'red' | 'slate' | 'blue'> = {
  EXACT: 'teal',
  CONFIRMED: 'teal',
  MANUAL: 'blue',
  AUTO_SUGGESTED: 'amber',
  UNMAPPED: 'red',
  INCOMPATIBLE: 'red',
  IGNORED: 'slate',
};

/**
 * Pairs a source table with the table it migrates into.
 *
 * Same-named tables pair themselves, so a Dataverse-to-Dataverse plan never sees this decision.
 * Across providers the platform can only suggest, and a suggestion blocks the plan until a person
 * confirms it — migrating rows into the wrong table is not a mistake anyone can quietly undo.
 */
export function ObjectMappingCard({
  plan,
  entity,
  onPlan,
}: {
  plan: MigrationPlanDto;
  entity: PlanEntityDto;
  onPlan: (p: MigrationPlanDto) => void;
}) {
  const sameName = entity.objectMappingStatus === 'EXACT' && entity.logicalName === entity.targetLogicalName;
  const candidates = useQuery({
    queryKey: ['target-candidates', plan.id, entity.id],
    queryFn: () => get<TargetCandidates>(`/api/plans/${plan.id}/entities/${entity.id}/target-candidates`),
    enabled: !sameName,
  });
  const update = useMutation({
    mutationFn: (body: { targetLogicalName: string | null; status: 'CONFIRMED' | 'MANUAL' | 'UNMAPPED' }) =>
      patch<MigrationPlanDto>(`/api/plans/${plan.id}/entities/${entity.id}/object-mapping`, body),
    onSuccess: onPlan,
  });

  if (sameName) return null;

  return (
    <Card
      title="Table mapping"
      subtitle="Which target table this source table's rows belong in."
      data-testid="object-mapping"
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="rounded-md border-l-4 border-l-[var(--color-source)] bg-slate-50 px-3 py-2">
          <Mono className="text-xs">{entity.logicalName}</Mono>
        </span>
        <ArrowRight className="h-4 w-4 text-slate-400" aria-hidden />
        <Select
          label="Target table"
          value={entity.targetLogicalName ?? ''}
          disabled={update.isPending || candidates.isLoading}
          onChange={(v) => update.mutate({ targetLogicalName: v || null, status: v ? 'MANUAL' : 'UNMAPPED' })}
          options={[
            { value: '', label: '— not mapped —' },
            ...(candidates.data?.allTargets ?? []).map((t) => ({
              value: t.logicalName,
              label: `${t.displayName} (${t.logicalName})`,
            })),
          ]}
        />
        <Pill tone={TONE[entity.objectMappingStatus]}>{entity.objectMappingStatus.toLowerCase()}</Pill>
        {entity.objectMappingStatus === 'AUTO_SUGGESTED' && entity.targetLogicalName && (
          <Button
            variant="primary"
            size="sm"
            icon={<Check className="h-3.5 w-3.5" />}
            loading={update.isPending}
            data-testid="confirm-object-mapping"
            onClick={() =>
              update.mutate({ targetLogicalName: entity.targetLogicalName, status: 'CONFIRMED' })
            }
          >
            Confirm {entity.targetDisplayName}
          </Button>
        )}
      </div>

      {update.error && (
        <div className="mt-3">
          <ErrorState error={update.error} />
        </div>
      )}
      {candidates.isLoading && <Spinner label="Looking for matching tables…" />}

      {entity.objectMappingStatus === 'AUTO_SUGGESTED' && (
        <div className="mt-3">
          <Callout tone="warning" title="Suggested, not decided">
            The names look similar, which is not evidence that the data belongs there. Confirm the target
            table (or choose another) before this plan can run.
          </Callout>
        </div>
      )}

      {(candidates.data?.candidates.length ?? 0) > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-slate-600">
          {candidates.data!.candidates.map((c) => (
            <li key={c.logicalName} className="flex items-center gap-2">
              <button
                type="button"
                className="font-medium text-brand-700 underline hover:text-brand-900"
                onClick={() => update.mutate({ targetLogicalName: c.logicalName, status: 'CONFIRMED' })}
              >
                Use {c.displayName}
              </button>
              <Pill>{c.confidence}%</Pill>
              <span className="text-slate-500">{c.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
