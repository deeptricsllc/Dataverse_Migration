import type { DataQualitySummaryDto, MigrationPlanDto } from '@shared/domain';
import { useMutation } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { LossyAcknowledgement } from './LossyAcknowledgement';
import { Button, Card, ErrorState, ExportButton, Pill, Spinner, Table, Td, Th } from './ui';
import { post } from '../lib/api';
import { fmtNumber } from '../lib/format';

/**
 * The data quality summary for a plan: what profiling found in the source, measured against the
 * rules the target schema implies, plus the acknowledgement for transformations that discard
 * information.
 */
export function DataQualityCard({
  plan,
  onPlan,
}: {
  plan: MigrationPlanDto;
  onPlan: (p: MigrationPlanDto) => void;
}) {
  const summary = useMutation({
    mutationFn: () => post<DataQualitySummaryDto>(`/api/plans/${plan.id}/data-quality`, {}),
  });
  return (
    <div className="space-y-5">
      <LossyAcknowledgement plan={plan} onPlan={onPlan} />

      <Card
        title="Data quality"
        subtitle="Profiles the source against the rules the target columns imply. Read-only."
        data-testid="data-quality"
        actions={
          <>
            <ExportButton href={`/api/plans/${plan.id}/data-quality.csv`} label="Export findings" />
            <Button
              variant="primary"
              size="sm"
              icon={<Play className="h-3.5 w-3.5" />}
              loading={summary.isPending}
              data-testid="run-profiling"
              onClick={() => summary.mutate()}
            >
              Profile the source
            </Button>
          </>
        }
      >
        {summary.isPending && <Spinner label="Reading the source data…" />}
        {summary.error && <ErrorState error={summary.error} />}
        {!summary.data && !summary.isPending && (
          <p className="text-sm text-slate-500">
            Reads the mapped source columns and reports what would stop a record from migrating: missing
            required values, values too long for the target, unmapped choices, invalid dates and duplicate
            keys.
          </p>
        )}
        {summary.data && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              {summary.data.tablesAnalyzed} table(s) · {fmtNumber(summary.data.recordsProfiled)} record(s)
              profiled ·{' '}
              <span className={summary.data.basis === 'EXACT' ? 'text-emerald-700' : 'text-amber-700'}>
                {summary.data.basis === 'EXACT' ? 'exact' : 'sampled'}
              </span>
            </p>
            <div className="flex gap-3">
              <Pill tone="red">{fmtNumber(summary.data.blockers)} blocker(s)</Pill>
              <Pill tone="amber">{fmtNumber(summary.data.warnings)} warning(s)</Pill>
            </div>
            {summary.data.categories.length === 0 ? (
              <p className="text-sm text-emerald-700">No data quality issues found.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Category</Th>
                    <Th>Severity</Th>
                    <Th className="text-right">Records</Th>
                  </tr>
                </thead>
                <tbody data-testid="quality-categories">
                  {summary.data.categories.map((c) => (
                    <tr key={c.code}>
                      <Td>{c.label}</Td>
                      <Td>
                        <Pill tone={c.severity === 'BLOCKER' ? 'red' : 'amber'}>
                          {c.severity.toLowerCase()}
                        </Pill>
                      </Td>
                      <Td className="text-right tabular-nums">{fmtNumber(c.count)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {summary.data.basis === 'SAMPLED' && (
              <p className="text-xs text-amber-800">
                These counts come from a sample, so they are a floor rather than a total. The preflight checks
                every record.
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
