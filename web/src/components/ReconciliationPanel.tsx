import { useState } from 'react';
import { describeCount } from '@shared/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MigrationRunDto } from '@shared/domain';
import {
  EVIDENCE_LABELS,
  RECONCILE_FINDING_LABELS,
  RECONCILE_FINDINGS,
  WRITE_STATE_LABELS,
  type ReconcileFinding,
  type ReconciliationEvidence,
  type WriteState,
} from '@shared/write-state';
import { Button, Callout, Card, EmptyState, ErrorState, Mono, Pill, Spinner } from './ui';
import { get, post } from '../lib/api';

interface Outstanding {
  total: number;
  items: {
    logicalName: string;
    sourceId: string;
    targetId: string | null;
    intendedOperation: string | null;
    writeState: WriteState | null;
    evidence: ReconciliationEvidence | null;
    note: string | null;
    attempts: number;
  }[];
}

/** What a person is recording about one record, before it is sent. */
interface Draft {
  found: ReconcileFinding | '';
  targetId: string;
  note: string;
}

/**
 * The records nobody can account for, and the place to settle them.
 *
 * The way out of a run that stopped because a write may have been applied and nothing the platform can
 * query would settle it. The only remaining evidence is somebody opening the target and looking, so this
 * screen's job is to tell them exactly what to look for and then record what they saw.
 *
 * The four answers are the point. `PRESENT` and `ABSENT` settle a record; `I cannot tell` and
 * `More than one record matches` do not, and are offered because a person who looked and could not tell
 * has to be able to say that. A form with only two buttons would make them pick one, and a confident
 * record of something nobody established is worse than an unresolved one — it is the same defect as a run
 * reporting a clean result because nothing failed.
 */
export function ReconciliationPanel({ run }: { run: MigrationRunDto }) {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const q = useQuery({
    queryKey: ['reconciliation', run.id, run.status, run.attempt],
    queryFn: () => get<Outstanding>(`/api/runs/${run.id}/reconciliation`),
  });
  const submit = useMutation({
    mutationFn: (resolutions: unknown[]) => post(`/api/runs/${run.id}/reconcile`, { resolutions }),
    onSuccess: async () => {
      setDrafts({});
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
      await qc.invalidateQueries({ queryKey: ['reconciliation', run.id] });
      await qc.invalidateQueries({ queryKey: ['retry-safety', run.id] });
    },
  });

  const keyOf = (i: { logicalName: string; sourceId: string }) => `${i.logicalName}:${i.sourceId}`;
  const draftOf = (k: string): Draft => drafts[k] ?? { found: '', targetId: '', note: '' };
  const set = (k: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [k]: { ...draftOf(k), ...patch } }));

  /*
   * A record is ready to send when the answer is chosen, the reason is written down, and — for a record
   * reported as present — the identifier it has in the target is given. The identifier is not a formality:
   * without it the identity map has nothing to point at, so the next attempt would write the record again,
   * which is the duplicate this whole screen exists to prevent. The server enforces the same rule.
   */
  const ready = Object.entries(drafts).filter(
    ([, d]) => d.found && d.note.trim().length >= 5 && (d.found !== 'PRESENT' || d.targetId.trim()),
  );

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data || q.data.total === 0) {
    return (
      <EmptyState
        title="Nothing is waiting"
        description="Every record in this run is accounted for. Nothing needs settling by hand."
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="reconciliation-panel">
      <Callout
        tone="warning"
        title={`${describeCount(q.data.total, 'record', 'records')} cannot be accounted for`}
      >
        A write was started for each of these and the answer was lost. Each one may or may not be in the
        target. Until that is settled, another attempt is refused: writing a record that is already there
        would create a second copy.
      </Callout>

      {q.data.items.map((item) => {
        const k = keyOf(item);
        const d = draftOf(k);
        const state = item.writeState ? WRITE_STATE_LABELS[item.writeState] : null;
        return (
          <Card key={k} data-testid="reconcile-record">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-900">{item.logicalName}</p>
                <Mono className="text-xs">{item.sourceId}</Mono>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {state && <Pill tone="amber">{state.label}</Pill>}
                {item.intendedOperation && <Pill>{item.intendedOperation}</Pill>}
                {item.attempts > 1 && <Pill>{item.attempts} attempts</Pill>}
              </div>
            </div>

            {state && <p className="mt-2 max-w-3xl text-xs text-slate-600">{state.meaning}</p>}

            {/*
              What to look for. A screen that said "check the target" and stopped would leave the person to
              work out which column identifies the record, which is the one thing the platform does know.
            */}
            <p className="mt-2 text-xs text-slate-600">
              <span className="font-medium text-slate-900">Look for</span>{' '}
              {item.evidence ? EVIDENCE_LABELS[item.evidence] : 'nothing recorded that identifies it'}
              {item.targetId && (
                <>
                  {' '}
                  — a target identifier was captured before the failure: <Mono>{item.targetId}</Mono>
                </>
              )}
              .
            </p>

            {item.note && (
              <p className="mt-2 rounded-md bg-slate-50 p-2 text-xs text-slate-700">
                Previously recorded: {item.note}
              </p>
            )}

            <fieldset className="mt-3">
              <legend className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                What did you find
              </legend>
              <div className="mt-1 space-y-1">
                {RECONCILE_FINDINGS.map((finding) => {
                  const f = RECONCILE_FINDING_LABELS[finding];
                  return (
                    <label key={finding} className="flex items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name={`found-${k}`}
                        className="mt-1"
                        checked={d.found === finding}
                        onChange={() => set(k, { found: finding })}
                        data-testid={`found-${finding}`}
                      />
                      <span>
                        <span className="text-slate-900">{f.label}</span>
                        {/* The consequence, beside the choice, because it is what the choice is for. */}
                        <span className="block text-xs text-slate-500">{f.consequence}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {d.found === 'PRESENT' && (
              <label className="mt-3 block text-xs text-slate-600">
                <span className="block font-medium text-slate-900">
                  The identifier the record has in the target
                </span>
                <input
                  className="mt-1 w-full max-w-md rounded-md border border-slate-300 px-2 py-1 font-mono text-xs"
                  value={d.targetId}
                  onChange={(e) => set(k, { targetId: e.target.value })}
                  data-testid="reconcile-target-id"
                />
                <span className="mt-1 block text-slate-500">
                  Required. Without it the identity map has nothing to point at, and another attempt would
                  write this record a second time.
                </span>
              </label>
            )}

            <label className="mt-3 block text-xs text-slate-600">
              <span className="block font-medium text-slate-900">How you determined it</span>
              <textarea
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                rows={2}
                value={d.note}
                onChange={(e) => set(k, { note: e.target.value })}
                placeholder="What you searched for, and what the target showed."
                data-testid="reconcile-note"
              />
              <span className="mt-1 block text-slate-500">
                Kept with the record. This is the only account of why the record reads the way it does.
              </span>
            </label>
          </Card>
        );
      })}

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-slate-500">
          {ready.length === 0
            ? 'Choose what you found, and write down how, for at least one record.'
            : `${ready.length.toLocaleString()} of ${q.data.total.toLocaleString()} ready to record.`}
        </p>
        <Button
          variant="primary"
          disabled={ready.length === 0}
          loading={submit.isPending}
          data-testid="submit-reconciliation"
          onClick={() =>
            submit.mutate(
              ready.map(([k, d]) => {
                const [logicalName, ...rest] = k.split(':');
                return {
                  logicalName,
                  sourceId: rest.join(':'),
                  found: d.found,
                  targetId: d.found === 'PRESENT' ? d.targetId.trim() : null,
                  note: d.note.trim(),
                };
              }),
            )
          }
        >
          Record what I found
        </Button>
      </div>
      {submit.error && <ErrorState error={submit.error} />}
    </div>
  );
}
