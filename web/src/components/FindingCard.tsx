import { useState } from 'react';
import { AlertTriangle, ChevronDown, Info, OctagonAlert } from 'lucide-react';
import type { Finding, FindingSeverity } from '@shared/findings';
import { FINDING_CATEGORY_LABELS } from '@shared/findings';
import { Button, cx } from './ui';

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

export function FindingCard({ finding, defaultOpen = false }: { finding: Finding; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const tone = TONE[finding.severity];

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
      className="relative overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
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
            </div>
            <h3 className="mt-1.5 text-sm font-semibold text-slate-900">{finding.title}</h3>
            {/* Where: dataset, table, column. A finding with no location cannot be acted on. */}
            <p className="mt-0.5 text-xs text-slate-500">
              {finding.dataset} · {finding.table}
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
      </div>
    </article>
  );
}
