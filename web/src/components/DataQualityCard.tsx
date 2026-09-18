import type { DataQualitySummaryDto, LossyTransformationDto, MigrationPlanDto } from '@shared/domain';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Play, ShieldAlert } from 'lucide-react';
import { Button, Callout, Card, ErrorState, ExportButton, Pill, Spinner, Table, Td, Th } from './ui';
import { get, post } from '../lib/api';
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
  const lossy = useQuery({
    queryKey: ['lossy', plan.id],
    queryFn: () => get<LossyTransformationDto[]>(`/api/plans/${plan.id}/lossy-transformations`),
  });
  const acknowledge = useMutation({
    mutationFn: (accepted: string[]) =>
      post<MigrationPlanDto>(`/api/plans/${plan.id}/lossy-transformations/acknowledge`, { accepted }),
    onSuccess: onPlan,
  });

  const accepted = new Set(plan.options.lossyAcknowledgement?.accepted ?? []);
  const unaccepted = (lossy.data ?? []).filter((l) => !accepted.has(l.key));

  return (
    <div className="space-y-5">
      {(lossy.data?.length ?? 0) > 0 && (
        <Card
          title="Transformations that discard information"
          subtitle="These have to be accepted by name before the migration can run."
          data-testid="lossy-transformations"
        >
          <Table>
            <thead>
              <tr>
                <Th>Table</Th>
                <Th>Field</Th>
                <Th>Transformation</Th>
                <Th>What is lost</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {lossy.data!.map((l) => (
                <tr key={l.key}>
                  <Td>{l.table}</Td>
                  <Td>
                    {l.field} → {l.targetField}
                  </Td>
                  <Td>
                    <Pill tone="amber">{l.kind.toLowerCase()}</Pill>
                  </Td>
                  <Td className="text-xs text-slate-600">{l.description}</Td>
                  <Td>
                    {accepted.has(l.key) ? (
                      <Pill tone="teal">accepted</Pill>
                    ) : (
                      <Pill tone="red">not accepted</Pill>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {unaccepted.length > 0 && (
            <div className="mt-3">
              <Callout tone="warning" title={`${unaccepted.length} transformation(s) need acceptance`}>
                Accepting records who accepted what, and when, in the run&apos;s audit trail. Adding another
                lossy transformation later asks the question again.
              </Callout>
              <Button
                className="mt-2"
                variant="primary"
                icon={<ShieldAlert className="h-4 w-4" />}
                loading={acknowledge.isPending}
                data-testid="acknowledge-lossy"
                onClick={() => acknowledge.mutate((lossy.data ?? []).map((l) => l.key))}
              >
                I accept these {unaccepted.length} transformation(s)
              </Button>
            </div>
          )}
          {plan.options.lossyAcknowledgement && unaccepted.length === 0 && (
            <p className="mt-2 text-xs text-slate-500">
              Accepted by {plan.options.lossyAcknowledgement.acknowledgedBy} on{' '}
              {new Date(plan.options.lossyAcknowledgement.acknowledgedAt).toLocaleString()}.
            </p>
          )}
          {acknowledge.error && <ErrorState error={acknowledge.error} />}
        </Card>
      )}

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
