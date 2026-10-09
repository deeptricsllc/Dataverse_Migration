import { useState } from 'react';
import type { AnalysisReadiness, ReadinessBand, ReadinessDimension } from '@shared/analysis-readiness';
import { READINESS_DIMENSION_DESCRIPTIONS, READINESS_DIMENSION_LABELS } from '@shared/analysis-readiness';
import type { Finding } from '@shared/findings';
import { FindingCard } from './FindingCard';
import { Card, cx } from './ui';

/**
 * The readiness figure, and the arithmetic behind it.
 *
 * The number is the least important thing on this panel. What makes it usable is that every dimension
 * shows its own working — "100 − 1 critical × 35 − 1 warning × 10 = 55" — and opening one produces the
 * findings that did the deducting. A score nobody can take apart invites a decision it cannot support,
 * which on a page about whether a migration is safe is worse than showing no score at all.
 *
 * A dimension that nothing examined says so, rather than showing full marks it never earned.
 */

const BAND: Record<ReadinessBand, { label: string; text: string; ring: string; bg: string }> = {
  READY: { label: 'Ready', text: 'text-emerald-700', ring: 'ring-emerald-200', bg: 'bg-emerald-50' },
  NEEDS_ATTENTION: {
    label: 'Needs attention',
    text: 'text-amber-800',
    ring: 'ring-amber-200',
    bg: 'bg-amber-50',
  },
  HIGH_RISK: { label: 'High risk', text: 'text-red-700', ring: 'ring-red-200', bg: 'bg-red-50' },
};

const barTone = (score: number) =>
  score >= 80 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-red-500';

export function ReadinessPanel({
  readiness,
  findings,
}: {
  readiness: AnalysisReadiness;
  findings: Finding[];
}) {
  const [open, setOpen] = useState<ReadinessDimension | null>(null);
  const band = readiness.band ? BAND[readiness.band] : null;

  if (readiness.score === null || !band) {
    return (
      <Card title="Migration readiness">
        <p className="text-sm text-slate-600">
          Nothing has been analysed yet, so there is no assessment. Add a dataset and run the analysis.
        </p>
      </Card>
    );
  }

  const byId = new Map(findings.map((f) => [f.id, f]));

  return (
    <Card
      title="Migration readiness"
      subtitle="Every deduction traces to a finding you can open"
      data-testid="readiness"
    >
      <div className="flex flex-wrap items-center gap-6">
        <div>
          <div className="flex items-baseline gap-1.5">
            <span
              data-testid="readiness-score"
              className="text-4xl font-semibold tabular-nums text-slate-900"
            >
              {readiness.score}
            </span>
            <span className="text-lg text-slate-400">/ 100</span>
          </div>
          <span
            data-testid="readiness-band"
            className={cx(
              'mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
              band.bg,
              band.text,
              band.ring,
            )}
          >
            {band.label}
          </span>
        </div>
        <dl className="flex gap-6 text-sm">
          {(
            [
              ['Critical', readiness.counts.CRITICAL, 'text-red-700'],
              ['Warnings', readiness.counts.WARNING, 'text-amber-800'],
              ['For information', readiness.counts.INFO, 'text-sky-700'],
            ] as const
          ).map(([label, value, tone]) => (
            <div key={label}>
              <dd className={cx('text-2xl font-semibold tabular-nums', tone)}>{value}</dd>
              <dt className="text-xs text-slate-500">{label}</dt>
            </div>
          ))}
        </dl>
      </div>

      <ul className="mt-6 space-y-1">
        {readiness.dimensions.map((dimension) => {
          const isOpen = open === dimension.dimension;
          const label = READINESS_DIMENSION_LABELS[dimension.dimension];
          const theirFindings = dimension.findingIds
            .map((id) => byId.get(id))
            .filter((f): f is Finding => Boolean(f));
          return (
            <li key={dimension.dimension} className="rounded-md border border-slate-100">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : dimension.dimension)}
                disabled={theirFindings.length === 0}
                aria-expanded={isOpen}
                className={cx(
                  'flex w-full items-center gap-4 px-3 py-2.5 text-left',
                  theirFindings.length > 0 ? 'hover:bg-slate-50' : 'cursor-default',
                )}
              >
                <span className="w-40 flex-none text-sm text-slate-700">{label}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                  {dimension.score !== null && (
                    <span
                      className={cx('block h-full rounded-full', barTone(dimension.score))}
                      style={{ width: `${dimension.score}%` }}
                    />
                  )}
                </span>
                <span className="w-28 flex-none text-right text-sm font-semibold tabular-nums text-slate-900">
                  {dimension.score === null ? (
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                      Not assessed
                    </span>
                  ) : (
                    dimension.score
                  )}
                </span>
              </button>
              <p className="px-3 pb-2.5 text-xs text-slate-500">
                {dimension.score === null
                  ? dimension.notAssessedReason
                  : /*
                     * Two sentences, not a clause joined by a dash.
                     * The workings end in a number more often than in a full stop ("100 - 1 critical
                     * x 35 = 65"), so one is added when it is missing rather than always.
                     */
                    `${dimension.workings.replace(/\.?$/, '.')} ${READINESS_DIMENSION_DESCRIPTIONS[dimension.dimension]}`}
              </p>
              {isOpen && theirFindings.length > 0 && (
                <div className="space-y-2 border-t border-slate-100 bg-slate-50/60 p-3">
                  {theirFindings.map((finding) => (
                    <FindingCard key={finding.id} finding={finding} />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="mt-4 border-t border-slate-100 pt-3 text-xs leading-relaxed text-slate-500">
        {readiness.method}
      </p>
    </Card>
  );
}
