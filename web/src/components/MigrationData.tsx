import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Database, Server } from 'lucide-react';
import type { EnvironmentDto, MigrationPlanDto, MigrationWorkspaceDto, PlanEntityDto } from '@shared/domain';
import { isStagedConnection, objectMappingReady } from '@shared/domain';
import { Button, Callout, Card, EmptyState, ErrorState, Modal, Pill, Spinner, cx } from './ui';
import { ObjectPicker } from './ObjectPicker';
import { api } from '../lib/api';
import { describeCount } from '../lib/format';

/**
 * What exactly is moving, and where it is going.
 *
 * The question this answers is §10's: *what are we moving?* — asked of the migration rather than of a
 * wizard step that disappeared once it was clicked past. Scope changes here as many times as the work
 * needs, which is what a migration actually is.
 *
 * The two ends and the scope are all properties of the project. Nothing here reads or writes an
 * application-wide "current source"; that model is gone.
 */
export function MigrationData({ w }: { w: MigrationWorkspaceDto }) {
  const [adding, setAdding] = useState(false);
  const [choosingTarget, setChoosingTarget] = useState(false);

  const plan = useQuery({
    queryKey: ['migration-plan', w.projectId],
    queryFn: () => api<MigrationPlanDto | null>('GET', `/api/projects/${w.projectId}/migration/plan`),
  });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Source data"
          subtitle={w.source ? w.source.displayName : 'Nothing chosen yet'}
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAdding(true)}
              data-testid="add-source-data"
            >
              {w.plan?.datasets ? 'Change source data' : 'Add source data'}
            </Button>
          }
        >
          {w.source ? (
            <p className="text-sm text-slate-600">
              {w.plan?.datasets
                ? `${describeCount(w.plan.datasets, 'dataset')} selected from this system.`
                : 'Connected, but nothing has been selected from it yet.'}
            </p>
          ) : (
            <p className="text-sm text-amber-800">
              Choose the system the data is coming from, and which of it you want to move.
            </p>
          )}
        </Card>

        <Card
          title="Destination"
          subtitle={w.target ? w.target.displayName : 'Not selected'}
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setChoosingTarget(true)}
              data-testid="choose-destination"
            >
              {w.target ? 'Change destination' : 'Choose destination'}
            </Button>
          }
        >
          {w.target ? (
            <TargetCapability target={w.target} capability={w.targetCapability} />
          ) : (
            <p className="text-sm text-amber-800">
              Select where this data should go. Nothing can be mapped until there is something to map onto.
            </p>
          )}
        </Card>
      </div>

      <Card
        title="Scope"
        subtitle="Each row is one source table and the target table it will be written into."
        data-testid="migration-scope-list"
        bodyClassName="p-0"
      >
        {plan.isLoading && (
          <div className="p-5">
            <Spinner label="Loading the configuration…" />
          </div>
        )}
        {plan.error && (
          <div className="p-5">
            <ErrorState error={plan.error} />
          </div>
        )}
        {plan.data && plan.data.entities.length > 0 ? (
          <ul className="divide-y divide-slate-100">
            {plan.data.entities.map((entity) => (
              <ScopeRow
                key={entity.id}
                entity={entity}
                crossProvider={
                  plan.data!.sourceEnvironment.connectionType !== plan.data!.targetEnvironment.connectionType
                }
              />
            ))}
          </ul>
        ) : (
          !plan.isLoading && (
            <div className="p-5">
              <EmptyState
                icon={<Database className="h-7 w-7" />}
                title="Nothing in scope yet"
                description="Add the tables you want to move. You can add or remove them at any point — doing so keeps the mapping work already done on the others."
              />
            </div>
          )
        )}
      </Card>

      {adding && <AddSourceData w={w} plan={plan.data ?? null} onClose={() => setAdding(false)} />}
      {choosingTarget && (
        <ChooseDestination w={w} plan={plan.data ?? null} onClose={() => setChoosingTarget(false)} />
      )}
    </div>
  );
}

/** One table in scope: how much of it there is, where it is going, and whether that is settled. */
function ScopeRow({ entity, crossProvider }: { entity: PlanEntityDto; crossProvider: boolean }) {
  // The domain's own rule: a suggestion is usable only when the names match exactly or a person confirmed it.
  const unconfirmed = !objectMappingReady(entity.objectMappingStatus);
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="scope-row">
      <span className="flex-none text-slate-400">
        <Database className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900">{entity.logicalName}</p>
        <p className="truncate text-xs text-slate-500">
          {entity.sourceCount === null
            ? 'Records not counted yet'
            : `${entity.sourceCount.toLocaleString()} records`}
        </p>
      </div>
      <span className="flex-none text-slate-300">→</span>
      <div className="min-w-0 flex-1">
        {entity.targetLogicalName ? (
          <>
            <p className="truncate text-sm text-slate-900">{entity.targetLogicalName}</p>
            <p className="text-xs text-slate-500">
              {/* Suggested is not confirmed. A name that looks similar is a reason to look, not a decision. */}
              {unconfirmed ? 'Suggested, not confirmed' : 'Confirmed'}
            </p>
          </>
        ) : (
          <p className="text-sm text-red-700">No target table chosen</p>
        )}
      </div>
      {/*
        How a rerun will tell an insert from an update.
        §23: "if I run this again, will I duplicate data?" is the question a migration turns on, and the
        answer was buried in a record-matching control four clicks inside a wizard step. A table matched on
        its source primary id across providers cannot be matched at all — the target assigns its own — so
        that case is named here rather than discovered by running it twice.
      */}
      <div className="w-56 flex-none">
        <p className="text-xs text-slate-500">Rerun matches on</p>
        <p
          className={cx(
            'truncate text-xs',
            entity.matchStrategy === 'PRIMARY_ID' && crossProvider ? 'text-red-700' : 'text-slate-800',
          )}
          title={entity.matchDescription}
        >
          {entity.matchDescription || 'not configured'}
        </p>
      </div>
      <span className="flex-none">
        {!entity.targetLogicalName ? (
          <Pill tone="red">Blocker</Pill>
        ) : unconfirmed ? (
          <Pill tone="amber">Needs confirming</Pill>
        ) : (
          <Pill tone="teal">Ready</Pill>
        )}
      </span>
    </li>
  );
}

/**
 * What the destination can actually do.
 *
 * §9: a read-only or simulated target must never look executable. The engine refuses the write either
 * way; this is so nobody plans a weekend around finding that out.
 */
function TargetCapability({
  target,
  capability,
}: {
  target: NonNullable<MigrationWorkspaceDto['target']>;
  capability: MigrationWorkspaceDto['targetCapability'];
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-600">{target.url}</p>
      {target.environmentClass === 'PRODUCTION' && <Pill tone="red">Production</Pill>}
      {capability?.simulated && (
        <Callout tone="warning" title="This destination is simulated">
          Nothing real is written. A run against it exercises the engine and proves the configuration; it is
          not evidence that a real system would accept this data.
        </Callout>
      )}
      {capability && !capability.writable && (
        <Callout tone="danger" title="This destination cannot be written to">
          {capability.reason} A migration into it would be refused, so it is not a destination you can execute
          against today.
        </Callout>
      )}
    </div>
  );
}

/**
 * Choosing the source system and what to take from it.
 *
 * The same picker the dataset experience uses, over the same endpoints and the same catalogue. §8 is
 * explicit that migration must not grow a second connector browser, and the fastest way to get one is to
 * build "almost the same" twice.
 */
function AddSourceData({
  w,
  plan,
  onClose,
}: {
  w: MigrationWorkspaceDto;
  plan: MigrationPlanDto | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [connectionId, setConnectionId] = useState<string | null>(w.source?.id ?? null);
  const [chosen, setChosen] = useState<Set<string>>(
    new Set((plan?.entities ?? []).map((e) => e.logicalName)),
  );

  const environments = useQuery({
    queryKey: ['environments'],
    queryFn: () => api<EnvironmentDto[]>('GET', '/api/environments'),
  });

  const save = useMutation({
    mutationFn: async () => {
      // The source is a property of the migration, set on the migration.
      if (connectionId && connectionId !== w.source?.id) {
        await api('PATCH', `/api/projects/${w.projectId}`, { sourceEnvironmentId: connectionId });
      }
      const tables = [...chosen];
      if (plan) {
        /*
         * Updating the selection rather than rebuilding the migration. Tables that stay keep their target
         * mapping, their field mappings and their match strategy; only the ones removed are dropped. A
         * person who adds a fourth table after mapping three has not asked to start again.
         */
        await api('PUT', `/api/plans/${plan.id}/tables`, { tables });
      } else {
        await api('POST', '/api/plans', {
          sourceEnvironmentId: connectionId,
          targetEnvironmentId: w.target!.id,
          projectId: w.projectId,
          tables,
        });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['migration-workspace', w.projectId] });
      await queryClient.invalidateQueries({ queryKey: ['migration-plan', w.projectId] });
      await queryClient.invalidateQueries({ queryKey: ['project', w.projectId] });
      onClose();
    },
  });

  const usable = (environments.data ?? []).filter(
    (e) => !isStagedConnection(e.connectionType) || e.connectionType !== 'FILE',
  );
  const connection = usable.find((e) => e.id === connectionId) ?? null;
  const needsTarget = !w.target && !plan;

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title="Add source data"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="save-source-data"
            disabled={!connection || chosen.size === 0 || needsTarget}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {chosen.size > 1 ? `Use ${chosen.size} tables` : 'Use this table'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {needsTarget && (
          <Callout tone="info" title="Choose a destination first">
            A migration's scope is a pairing: each source table is written into a target table. Choose where
            the data is going, and this will have something to map onto.
          </Callout>
        )}

        <label className="block">
          <span className="text-xs font-medium text-slate-600">Source system</span>
          <select
            value={connectionId ?? ''}
            onChange={(e) => {
              setConnectionId(e.target.value || null);
              setChosen(new Set());
            }}
            data-testid="source-connection"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="">Choose a system…</option>
            {usable.map((e) => (
              <option key={e.id} value={e.id}>
                {e.displayName}
              </option>
            ))}
          </select>
        </label>

        {connection && (
          <ObjectPicker
            connection={connection}
            chosen={chosen}
            onToggle={(name) =>
              setChosen((previous) => {
                const next = new Set(previous);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                return next;
              })
            }
          />
        )}
        {save.error && <ErrorState error={save.error} />}
      </div>
    </Modal>
  );
}

/**
 * Choosing where the data goes, and saying what changing it costs.
 *
 * §32: changing the destination after mapping exists is consequential, and silently keeping mappings that
 * may no longer be valid is the worst of the available options. Historical runs are untouched either way
 * — they describe what happened, which does not change because the plan did.
 */
function ChooseDestination({
  w,
  plan,
  onClose,
}: {
  w: MigrationWorkspaceDto;
  plan: MigrationPlanDto | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [targetId, setTargetId] = useState<string | null>(w.target?.id ?? null);
  const environments = useQuery({
    queryKey: ['environments'],
    queryFn: () => api<EnvironmentDto[]>('GET', '/api/environments'),
  });

  const save = useMutation({
    mutationFn: async () => {
      await api('PATCH', `/api/projects/${w.projectId}`, { targetEnvironmentId: targetId });
      // The configuration is reassessed against the new destination rather than assumed to still hold.
      if (plan) await api('POST', `/api/plans/${plan.id}/revalidate`);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['migration-workspace', w.projectId] });
      await queryClient.invalidateQueries({ queryKey: ['migration-plan', w.projectId] });
      await queryClient.invalidateQueries({ queryKey: ['project', w.projectId] });
      onClose();
    },
  });

  const writable = (environments.data ?? []).filter(
    (e) => !isStagedConnection(e.connectionType) && e.id !== w.source?.id,
  );
  const changing = Boolean(w.target && targetId && targetId !== w.target.id);
  const hasWork = Boolean(plan && plan.entities.length > 0);

  return (
    <Modal
      open
      onClose={onClose}
      title="Choose destination"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={changing && hasWork ? 'danger' : 'primary'}
            data-testid="save-destination"
            disabled={!targetId || targetId === w.target?.id}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {changing && hasWork ? 'Change destination anyway' : 'Use this destination'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Destination system</span>
          <select
            value={targetId ?? ''}
            onChange={(e) => setTargetId(e.target.value || null)}
            data-testid="destination-connection"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="">Choose a system…</option>
            {writable.map((e) => (
              <option key={e.id} value={e.id}>
                {e.displayName}
              </option>
            ))}
          </select>
        </label>

        {changing && hasWork && (
          <Callout tone="danger" title="This may invalidate work already done">
            <p>
              {describeCount(plan!.entities.length, 'table')} are mapped against{' '}
              <strong>{w.target!.displayName}</strong>. Moving to a different destination may invalidate table
              mappings, field mappings, choice mappings, user mappings and lookup configuration, because the
              new system is not obliged to have the same schema.
            </p>
            <p className="mt-2">
              The configuration is reassessed afterwards and anything that no longer holds is reported as a
              blocker. Runs that have already happened are untouched — they describe what happened, which does
              not change because the plan did.
            </p>
          </Callout>
        )}

        {!w.target && (
          <p className="flex items-start gap-2 text-xs text-slate-500">
            <Server className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden />
            Only systems that can be written to are offered, and the source itself is not among them.
          </p>
        )}

        {save.error && <ErrorState error={save.error} />}
        {environments.isLoading && <Spinner label="Loading systems…" />}
        {!environments.isLoading && writable.length === 0 && (
          <p className="flex items-start gap-2 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
            There is no other system to migrate into yet. Add one on the Connections page.
          </p>
        )}
      </div>
    </Modal>
  );
}
