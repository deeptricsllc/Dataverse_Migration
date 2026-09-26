import {
  SCHEDULE_MODES,
  type MigrationPlanDto,
  type MigrationScheduleDto,
  type ScheduleMode,
  type ScheduleRunHistoryItemDto,
} from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pause, Play, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, get, patch, post } from '../lib/api';
import { fmtDate, fmtNumber, fmtRelative } from '../lib/format';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Disclosure,
  ErrorState,
  Modal,
  Pill,
  Select,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from './ui';

/** Presets, and the escape hatch for anyone who thinks in cron. */
const PRESETS = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 4 hours', cron: '0 */4 * * *' },
  { label: 'Every day at 02:00', cron: '0 2 * * *' },
  { label: 'Every weekday at 06:00', cron: '0 6 * * 1-5' },
  { label: 'Every Sunday at 01:00', cron: '0 1 * * 0' },
];

const MODE_HELP: Record<ScheduleMode, string> = {
  FULL: 'Re-reads every record each time. The engine still only writes what differs, so repeating a full run is safe.',
  INCREMENTAL:
    'Only reads records changed since the last run, using a watermark column. The way to keep up with a table that changes constantly.',
};

/**
 * Schedules for one plan.
 *
 * A migration is only correct at the moment somebody ran it, which is why this exists. The card is
 * deliberately blunt about what a scheduled run still refuses to do without a person: it will not
 * run a plan with blockers, and it will not run transformations that discard data unless those were
 * already accepted.
 */
export function SchedulesCard({ plan }: { plan: MigrationPlanDto }) {
  const [creating, setCreating] = useState(false);
  const schedules = useQuery({
    queryKey: ['schedules', plan.id],
    queryFn: () => get<MigrationScheduleDto[]>(`/api/plans/${plan.id}/schedules`),
  });

  return (
    <Card
      title="Scheduled runs"
      subtitle="Keep the target up to date as the source changes, or trigger a run on demand."
      data-testid="schedules"
      actions={
        <Button
          size="sm"
          variant="primary"
          icon={<CalendarClock className="h-3.5 w-3.5" />}
          data-testid="new-schedule"
          onClick={() => setCreating(true)}
        >
          Add a schedule
        </Button>
      }
    >
      {schedules.isLoading && <Spinner label="Loading schedules…" />}
      {schedules.error && <ErrorState error={schedules.error} />}
      {schedules.data?.length === 0 && (
        <p className="text-sm text-slate-500">
          No schedule yet. A scheduled run goes through the same checks as a manual one — it will not run a
          plan with unresolved blockers, and it will not perform a transformation that discards data unless
          that was already accepted.
        </p>
      )}

      {(schedules.data?.length ?? 0) > 0 && (
        <div className="space-y-3">
          {schedules.data!.map((s) => (
            <ScheduleRow key={s.id} schedule={s} planId={plan.id} />
          ))}
        </div>
      )}

      <NewScheduleModal plan={plan} open={creating} onClose={() => setCreating(false)} />
    </Card>
  );
}

function ScheduleRow({ schedule: s, planId }: { schedule: MigrationScheduleDto; planId: string }) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['schedules', planId] });
    void qc.invalidateQueries({ queryKey: ['schedule-history', s.id] });
  };
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patch<MigrationScheduleDto>(`/api/schedules/${s.id}`, { enabled }),
    onSuccess: invalidate,
  });
  const trigger = useMutation({
    mutationFn: () => post<{ runId: string }>(`/api/schedules/${s.id}/trigger`),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api<void>('DELETE', `/api/schedules/${s.id}`),
    onSuccess: invalidate,
  });

  return (
    <div className="rounded-lg border border-slate-200 p-3" data-testid={`schedule-${s.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-slate-800">
            {s.name} {s.enabled ? <Pill tone="teal">on</Pill> : <Pill tone="slate">paused</Pill>}{' '}
            {s.mode === 'INCREMENTAL' && <Pill tone="violet">incremental</Pill>}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {s.description} · {s.timeZone} · <code className="font-mono">{s.cron}</code>
            {s.mode === 'INCREMENTAL' && s.watermarkField && <> · watermark {s.watermarkField}</>}
          </p>
          <p className="mt-1 text-xs text-slate-600">
            {s.enabled && s.nextRunAt ? (
              <>
                Next run {fmtDate(s.nextRunAt)}{' '}
                <span className="text-slate-400">({fmtRelative(s.nextRunAt)})</span>
              </>
            ) : (
              'Not scheduled to run.'
            )}
            {s.lastRunAt && (
              <>
                {' · '}last {fmtRelative(s.lastRunAt)} {s.lastStatus && <StatusBadge status={s.lastStatus} />}
                {s.lastRunId && (
                  <>
                    {' '}
                    <Link to={`/runs/${s.lastRunId}`} className="text-brand-700 hover:underline">
                      view run
                    </Link>
                  </>
                )}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            icon={<Zap className="h-3.5 w-3.5" />}
            loading={trigger.isPending}
            data-testid={`trigger-${s.id}`}
            onClick={() => trigger.mutate()}
          >
            Run now
          </Button>
          <Button
            size="sm"
            icon={s.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            loading={toggle.isPending}
            onClick={() => toggle.mutate(!s.enabled)}
          >
            {s.enabled ? 'Pause' : 'Resume'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 className="h-3.5 w-3.5" />}
            loading={remove.isPending}
            onClick={() => remove.mutate()}
            aria-label={`Delete ${s.name}`}
          />
        </div>
      </div>

      {s.pausedReason && (
        <Callout tone="danger" title="Paused automatically">
          {s.pausedReason} Resume it once the cause is fixed — resuming clears the failure count.
        </Callout>
      )}
      {!s.pausedReason && s.lastError && s.lastStatus !== 'SKIPPED' && (
        <p className="mt-2 text-xs text-red-700">Last error: {s.lastError}</p>
      )}
      {s.lastStatus === 'SKIPPED' && (
        <p className="mt-2 text-xs text-amber-700">
          The last firing was skipped because a run was still in progress. Nothing was lost; the next slot
          will pick it up.
        </p>
      )}
      {trigger.error && <ErrorState error={trigger.error} />}

      <div className="mt-2">
        <Disclosure summary="Run history">
          <ScheduleHistory scheduleId={s.id} />
        </Disclosure>
      </div>
    </div>
  );
}

function ScheduleHistory({ scheduleId }: { scheduleId: string }) {
  const history = useQuery({
    queryKey: ['schedule-history', scheduleId],
    queryFn: () => get<ScheduleRunHistoryItemDto[]>(`/api/schedules/${scheduleId}/history`),
  });
  if (history.isLoading) return <Spinner />;
  if (history.error) return <ErrorState error={history.error} />;
  if (!history.data?.length) return <p className="text-sm text-slate-500">This schedule has not run yet.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Started</Th>
          <Th>Status</Th>
          <Th>Trigger</Th>
          <Th className="text-right">Created</Th>
          <Th className="text-right">Updated</Th>
          <Th className="text-right">Failed</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {history.data.map((h) => (
          <tr key={h.runId}>
            <Td className="text-xs">{h.startedAt ? fmtDate(h.startedAt) : '—'}</Td>
            <Td>
              <StatusBadge status={h.status} />
            </Td>
            <Td className="text-xs">{h.trigger.toLowerCase()}</Td>
            <Td className="text-right tabular-nums">{fmtNumber(h.created)}</Td>
            <Td className="text-right tabular-nums">{fmtNumber(h.updated)}</Td>
            <Td className="text-right tabular-nums">
              {h.failed > 0 ? <span className="text-red-700">{fmtNumber(h.failed)}</span> : '—'}
            </Td>
            <Td>
              <Link to={`/runs/${h.runId}`} className="text-xs text-brand-700 hover:underline">
                open
              </Link>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function NewScheduleModal({
  plan,
  open,
  onClose,
}: {
  plan: MigrationPlanDto;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [preset, setPreset] = useState(PRESETS[3].cron);
  const [custom, setCustom] = useState(false);
  const [cron, setCron] = useState(PRESETS[3].cron);
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [mode, setMode] = useState<ScheduleMode>('FULL');
  const [watermarkField, setWatermarkField] = useState('modifiedon');
  const [confirmTarget, setConfirmTarget] = useState('');

  const create = useMutation({
    mutationFn: () =>
      post<MigrationScheduleDto>(`/api/plans/${plan.id}/schedules`, {
        cron: custom ? cron : preset,
        timeZone,
        mode,
        watermarkField: mode === 'INCREMENTAL' ? watermarkField : null,
        confirmSourceName: plan.sourceEnvironment.displayName,
        confirmTargetName: confirmTarget,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedules', plan.id] });
      onClose();
    },
  });

  const confirmed = confirmTarget.trim() === plan.targetEnvironment.displayName;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule this migration"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!confirmed}
            loading={create.isPending}
            data-testid="create-schedule"
            onClick={() => create.mutate()}
          >
            Create schedule
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Callout tone="warning" title="A scheduled run writes to the target with nobody watching">
          It goes through the same checks as a manual run: a plan with unresolved blockers will not run, and a
          transformation that discards data will not run unless it was already accepted. What it cannot do is
          ask you to confirm the target, so you confirm it now — and if the plan is ever pointed somewhere
          else, the schedule stops instead of following it.
        </Callout>

        {!custom ? (
          <Select
            label="How often"
            value={preset}
            onChange={setPreset}
            options={PRESETS.map((p) => ({ value: p.cron, label: p.label }))}
            className="w-full"
          />
        ) : (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="cron">
              Cron expression
            </label>
            <input
              id="cron"
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              value={cron}
              placeholder="0 2 * * *"
              onChange={(e) => setCron(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500">
              Five fields: minute, hour, day of month, month, day of week.
            </p>
          </div>
        )}
        <Checkbox checked={custom} onChange={setCustom} label="Use a cron expression instead" />

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="tz">
            Time zone
          </label>
          <input
            id="tz"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">
            The time is a wall clock in this zone, so 02:00 stays 02:00 across a daylight-saving change.
          </p>
        </div>

        <div>
          <Select
            label="What it reads"
            value={mode}
            onChange={(v) => setMode(v as ScheduleMode)}
            options={SCHEDULE_MODES.map((m) => ({
              value: m,
              label: m === 'FULL' ? 'Everything, every time' : 'Only what changed',
            }))}
            className="w-full"
          />
          <p className="mt-1.5 text-xs text-slate-500">{MODE_HELP[mode]}</p>
        </div>
        {mode === 'INCREMENTAL' && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="watermark">
              Watermark column
            </label>
            <input
              id="watermark"
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              value={watermarkField}
              onChange={(e) => setWatermarkField(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500">
              A column that increases when a record changes — <code>modifiedon</code> in Dataverse, a
              row-version or last-modified column in SQL. Records with a higher value than the last run are
              re-read; the first run reads everything.
            </p>
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="confirm-target">
            Type the target name to confirm:{' '}
            <code className="font-mono">{plan.targetEnvironment.displayName}</code>
          </label>
          <input
            id="confirm-target"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            value={confirmTarget}
            data-testid="confirm-schedule-target"
            onChange={(e) => setConfirmTarget(e.target.value)}
          />
        </div>
        {create.error && <ErrorState error={create.error} />}
      </div>
    </Modal>
  );
}
