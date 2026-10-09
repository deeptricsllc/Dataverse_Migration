import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Info, OctagonAlert, UserCheck } from 'lucide-react';
import type {
  Finding,
  FindingDisposition,
  FindingDispositionStatus,
  FindingSeverity,
} from '@shared/findings';
import {
  dispositionSilences,
  FINDING_CATEGORY_LABELS,
  FINDING_DISPOSITIONS,
  FINDING_DISPOSITION_DESCRIPTIONS,
  FINDING_DISPOSITION_LABELS,
  findingDeducts,
} from '@shared/findings';
import { DIMENSION_FOR, READINESS_DIMENSION_LABELS } from '@shared/analysis-readiness';
import { api } from '../lib/api';
import { Button, Select, cx } from './ui';

/**
 * One finding, answering the five questions it is required to answer.
 *
 * What happened, where, how much is affected, why it matters, what to do. Those are laid out in that
 * order and all five are visible without opening anything — because a finding whose consequence is
 * one click away is a statistic with extra steps.
 *
 * The evidence is the part that collapses. A reader deciding what to fix needs the first four; a
 * reader who does not believe us needs the numbers underneath, and they should not have to read them
 * to get to the next finding.
 */

const TONE: Record<FindingSeverity, { bar: string; chip: string; icon: typeof Info; label: string }> = {
  CRITICAL: {
    bar: 'bg-red-500',
    chip: 'bg-red-50 text-red-700 ring-red-200',
    icon: OctagonAlert,
    label: 'Critical',
  },
  WARNING: {
    bar: 'bg-amber-500',
    chip: 'bg-amber-50 text-amber-800 ring-amber-200',
    icon: AlertTriangle,
    label: 'Warning',
  },
  INFO: {
    bar: 'bg-sky-500',
    chip: 'bg-sky-50 text-sky-700 ring-sky-200',
    icon: Info,
    label: 'For information',
  },
};

export function SeverityChip({ severity }: { severity: FindingSeverity }) {
  const tone = TONE[severity];
  const Icon = tone.icon;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset',
        tone.chip,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {tone.label}
    </span>
  );
}

export function FindingCard({
  finding,
  defaultOpen = false,
  projectId,
  disposition = null,
}: {
  finding: Finding;
  defaultOpen?: boolean;
  /** Only given where a decision can be recorded. The overview shows findings without the control. */
  projectId?: string;
  disposition?: FindingDisposition | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const tone = TONE[finding.severity];
  const settled = dispositionSilences(disposition?.status);
  const dimension = DIMENSION_FOR[finding.category];

  /** "1,420 records (40%)" — the scale of the problem, which decides whether it is worth fixing first. */
  const scale =
    finding.affected > 0
      ? `${finding.affected.toLocaleString()} ${finding.affected === 1 ? 'record' : 'records'}${
          finding.affectedPercent !== null ? ` · ${finding.affectedPercent}%` : ''
        }`
      : null;

  return (
    <article
      data-testid="finding"
      data-severity={finding.severity}
      data-disposition={disposition?.status ?? 'OPEN'}
      className={cx(
        'relative overflow-hidden rounded-lg border bg-white shadow-sm transition-opacity',
        /*
         * A finding somebody has settled is still here, with its evidence intact — the observation did
         * not stop being true. It is quieter, because a list where the decided and the undecided look
         * identical is a list nobody can work through.
         */
        settled ? 'border-slate-200 opacity-60' : 'border-slate-200',
      )}
    >
      {/* Severity as a quiet edge rather than a coloured panel: obvious at a glance, calm in a list. */}
      <div className={cx('absolute inset-y-0 left-0 w-1', tone.bar)} aria-hidden />
      <div className="pl-5 pr-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityChip severity={finding.severity} />
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                {FINDING_CATEGORY_LABELS[finding.category]}
              </span>
              {/*
                How this finding reaches the score.
                The readiness panel promises that every deduction traces to a finding you can open.
                Read from the other end that promise was unverifiable: a reader looking at a finding
                had no way to tell whether it had cost anything, and two categories deliberately
                cost nothing at all. Saying so here closes the loop in the direction people read it.
              */}
              <span
                className="text-[11px] font-medium uppercase tracking-wide text-slate-400"
                data-testid="finding-readiness"
              >
                {dimension === null
                  ? '· not scored'
                  : findingDeducts(finding)
                    ? `· counts against ${READINESS_DIMENSION_LABELS[dimension]}`
                    : `· ${READINESS_DIMENSION_LABELS[dimension]}, no deduction`}
              </span>
            </div>
            <h3 className="mt-1.5 text-sm font-semibold text-slate-900">{finding.title}</h3>
            {/* Where: dataset, table, column. A finding with no location cannot be acted on. */}
            <p className="mt-0.5 text-xs text-slate-500">
              {/*
                A one-file dataset is usually named after the file, so the dataset and the table end up
                with the same name and the line reads "Customers · Customers · legacy_notes". Saying it
                once is not losing information; it is not repeating it.
              */}
              {finding.dataset === finding.table ? finding.table : `${finding.dataset} · ${finding.table}`}
              {finding.columns.length > 0 && (
                <>
                  {' · '}
                  <span className="font-mono text-[11px]">{finding.columns.join(', ')}</span>
                </>
              )}
            </p>
          </div>
          {scale && (
            <div className="text-right">
              <div className="text-sm font-semibold tabular-nums text-slate-900">
                {finding.affected.toLocaleString()}
              </div>
              <div className="text-[11px] text-slate-500">
                {finding.affectedPercent !== null ? `${finding.affectedPercent}% of records` : 'records'}
              </div>
            </div>
          )}
        </div>

        <p className="mt-3 text-sm leading-relaxed text-slate-700">{finding.summary}</p>

        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Why it matters</dt>
            <dd className="mt-0.5 leading-relaxed text-slate-600">{finding.whyItMatters}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">What to do</dt>
            <dd className="mt-0.5 leading-relaxed text-slate-700">{finding.recommendation}</dd>
          </div>
        </dl>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            icon={<ChevronDown className={cx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />}
          >
            {open ? 'Hide evidence' : 'Evidence'}
          </Button>
          {/* Said plainly rather than as a number: "0.9724" next to a fact is not a confidence, it is a prop. */}
          {finding.confidence === 'MEDIUM' && (
            <span className="text-[11px] text-slate-500">
              Worth checking — this reading is likely rather than certain
            </span>
          )}
          {finding.basis !== 'EXACT' && (
            <span className="text-[11px] text-slate-500">Measured on a sample</span>
          )}
        </div>

        {open && (
          <div className="mt-3 rounded-md bg-slate-50 px-3.5 py-3">
            <ul className="space-y-1.5 text-xs leading-relaxed text-slate-600">
              {finding.evidence.map((line, i) => (
                <li key={i} className="flex gap-2">
                  <span className="select-none text-slate-300" aria-hidden>
                    —
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 border-t border-slate-200 pt-2.5 text-xs text-slate-500">
              <span className="font-semibold text-slate-600">If migrated as it is: </span>
              {finding.migrationImpact}
            </p>
          </div>
        )}

        {projectId && (
          <DispositionControl projectId={projectId} finding={finding} disposition={disposition} />
        )}
      </div>
    </article>
  );
}

/**
 * What a person decided, kept visibly apart from what the engine observed.
 *
 * Everything above this line is evidence and does not change when a decision is recorded — the finding is
 * recomputed from the stored profile every time, so an accepted risk still shows the same counts it always
 * did. This strip is the only part a human writes, and it says who and when, because a decision nobody can
 * attribute is barely a decision.
 */
function DispositionControl({
  projectId,
  finding,
  disposition,
}: {
  projectId: string;
  finding: Finding;
  disposition: FindingDisposition | null;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(disposition?.note ?? '');
  const queryClient = useQueryClient();
  const status = disposition?.status ?? 'OPEN';

  const save = useMutation({
    mutationFn: (next: FindingDispositionStatus) =>
      api('PUT', `/api/projects/${projectId}/findings/${encodeURIComponent(finding.id)}/disposition`, {
        status: next,
        note: note.trim() || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['assessment', projectId] });
      setEditing(false);
    },
  });

  return (
    <div data-testid="disposition" className="mt-3 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <UserCheck className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Your decision</span>
        {status !== 'OPEN' && (
          <span
            data-testid="disposition-status"
            className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700"
          >
            {FINDING_DISPOSITION_LABELS[status]}
          </span>
        )}
        {disposition && (
          <span className="text-[11px] text-slate-400">
            {disposition.decidedBy ? `${disposition.decidedBy} · ` : ''}
            {new Date(disposition.decidedAt).toLocaleDateString()}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>
          {status === 'OPEN' ? 'Record a decision' : 'Change'}
        </Button>
      </div>

      {disposition?.note && !editing && (
        <p className="mt-1.5 text-xs italic leading-relaxed text-slate-600">“{disposition.note}”</p>
      )}

      {editing && (
        <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-3">
          <Select
            label="Decision"
            value={status}
            onChange={(v) => save.mutate(v as FindingDispositionStatus)}
            options={FINDING_DISPOSITIONS.map((d) => ({
              value: d,
              label: FINDING_DISPOSITION_LABELS[d],
            }))}
          />
          <p className="text-[11px] text-slate-500">{FINDING_DISPOSITION_DESCRIPTIONS[status]}</p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Why, and who agreed. Optional, and the thing you will want in six months."
            aria-label="Decision note"
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(status)}>
              Save decision
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
