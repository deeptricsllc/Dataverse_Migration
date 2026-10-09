import type { LossyRecordDto, LossyTransformationDto, MigrationPlanDto } from '@shared/domain';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ShieldAlert, TableIcon } from 'lucide-react';
import { useState } from 'react';
import { get, post } from '../lib/api';
import { fmtNumber } from '../lib/format';
import { Button, Callout, Card, ErrorState, ExportButton, Pill, Spinner, Table, Td, Th } from './ui';

/**
 * The gate in front of transformations that permanently discard source data.
 *
 * Every transformation is named, and — this is the point of the screen — says how many records it
 * actually changes, not how many it runs on. The number is measured by the preflight when one has
 * run and is labelled an estimate when it comes from a bounded sample, because "38 records will be
 * truncated" is a promise the number has to keep.
 */
export function LossyAcknowledgement({
  plan,
  onPlan,
}: {
  plan: MigrationPlanDto;
  onPlan: (p: MigrationPlanDto) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const lossy = useQuery({
    queryKey: ['lossy', plan.id],
    queryFn: () => get<LossyTransformationDto[]>(`/api/plans/${plan.id}/lossy-transformations`),
  });
  const acknowledge = useMutation({
    mutationFn: (accepted: string[]) =>
      post<MigrationPlanDto>(`/api/plans/${plan.id}/lossy-transformations/acknowledge`, { accepted }),
    onSuccess: onPlan,
  });

  const items = lossy.data ?? [];
  if (items.length === 0) return null;
  const accepted = new Set(plan.options.lossyAcknowledgement?.accepted ?? []);
  const unaccepted = items.filter((l) => !accepted.has(l.key));

  const toggle = (key: string) => {
    const next = new Set(accepted);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    acknowledge.mutate([...next]);
  };

  return (
    <Card
      title="Data loss acknowledgement required"
      subtitle="These transformations permanently discard source data. Each has to be accepted by name."
      data-testid="lossy-transformations"
    >
      <div className="space-y-4">
        {items.map((l) => (
          <div
            key={l.key}
            className="rounded-lg border border-amber-200 bg-amber-50/60 p-4"
            data-testid={`lossy-${l.key}`}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-800">
                  {l.field} → {[l.targetTable, l.targetField].filter(Boolean).join('.') || '—'}
                </p>
                <p className="mt-0.5 text-xs text-slate-600">
                  <Pill tone="amber">{ruleLabel(l)}</Pill> <span className="ml-1">{l.description}</span>
                </p>

                <p className="mt-2 text-sm text-slate-800" data-testid={`affected-${l.key}`}>
                  {impactSentence(l)}
                </p>
                <dl className="mt-1 space-y-0.5 text-xs text-slate-600">
                  {l.maxSourceLength !== null && (
                    <div>
                      Maximum source length:{' '}
                      <span className="tabular-nums">{fmtNumber(l.maxSourceLength)}</span>
                    </div>
                  )}
                  {l.targetMaxLength !== null && (
                    <div>
                      Target maximum length:{' '}
                      <span className="tabular-nums">{fmtNumber(l.targetMaxLength)}</span>
                    </div>
                  )}
                  {l.examined !== null && (
                    <div>
                      Total records analyzed: <span className="tabular-nums">{fmtNumber(l.examined)}</span>
                    </div>
                  )}
                </dl>
                <p
                  className={`mt-1 text-xs ${l.basis === 'EXACT' ? 'text-emerald-700' : 'text-amber-800'}`}
                  data-testid={`basis-${l.key}`}
                >
                  {basisNote(l)}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    icon={<TableIcon className="h-3.5 w-3.5" />}
                    disabled={!l.fromPreflight}
                    data-testid={`view-affected-${l.key}`}
                    onClick={() => setOpenKey(openKey === l.key ? null : l.key)}
                  >
                    {openKey === l.key ? 'Hide affected records' : 'View affected records'}
                  </Button>
                  {l.fromPreflight && (
                    <ExportButton
                      href={`/api/plans/${plan.id}/lossy-records.csv?key=${encodeURIComponent(l.key)}`}
                      label="Export affected records"
                    />
                  )}
                  {!l.fromPreflight && (
                    <span className="text-xs text-slate-500">
                      Run a preflight to list and export the affected records.
                    </span>
                  )}
                </div>

                {openKey === l.key && <AffectedRecords planId={plan.id} transformationKey={l.key} />}

                <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-slate-400"
                    checked={accepted.has(l.key)}
                    disabled={acknowledge.isPending}
                    data-testid={`accept-${l.key}`}
                    onChange={() => toggle(l.key)}
                  />
                  <span>
                    I understand that this transformation permanently discards source data in the migrated
                    target.
                  </span>
                </label>
              </div>
            </div>
          </div>
        ))}
      </div>

      {unaccepted.length > 0 && (
        <div className="mt-4">
          <Callout tone="warning" title={`${unaccepted.length} transformation(s) need acceptance`}>
            Accepting records who accepted what, and when, in the run&apos;s audit trail. Adding another lossy
            transformation later asks the question again.
          </Callout>
          <Button
            className="mt-2"
            variant="primary"
            icon={<ShieldAlert className="h-4 w-4" />}
            loading={acknowledge.isPending}
            data-testid="acknowledge-lossy"
            onClick={() => acknowledge.mutate(items.map((l) => l.key))}
          >
            I accept all {unaccepted.length} transformation(s)
          </Button>
        </div>
      )}
      {plan.options.lossyAcknowledgement && unaccepted.length === 0 && (
        <p className="mt-3 text-xs text-slate-500">
          Accepted by {plan.options.lossyAcknowledgement.acknowledgedBy} on{' '}
          {new Date(plan.options.lossyAcknowledgement.acknowledgedAt).toLocaleString()}.
        </p>
      )}
      {acknowledge.error && <ErrorState error={acknowledge.error} />}
    </Card>
  );
}

/** The records the preflight saw lose something, exactly as the export lists them. */
function AffectedRecords({ planId, transformationKey }: { planId: string; transformationKey: string }) {
  const records = useQuery({
    queryKey: ['lossy-records', planId, transformationKey],
    queryFn: () =>
      get<{ items: LossyRecordDto[]; total: number }>(
        `/api/plans/${planId}/lossy-records?key=${encodeURIComponent(transformationKey)}&limit=50`,
      ),
  });
  if (records.isPending) return <Spinner label="Reading the preflight…" />;
  if (records.error) return <ErrorState error={records.error} />;
  const { items = [], total = 0 } = records.data ?? {};
  if (items.length === 0) return <p className="mt-2 text-xs text-slate-500">No affected records recorded.</p>;
  return (
    <div className="mt-3" data-testid={`affected-records-${transformationKey}`}>
      <Table>
        <thead>
          <tr>
            <Th>Record ID</Th>
            <Th>Original value</Th>
            <Th>Transformed value</Th>
            <Th>What is lost</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((r, i) => (
            <tr key={`${r.sourceRecordId}-${i}`}>
              <Td className="font-mono text-xs">{r.recordName ?? r.sourceRecordId}</Td>
              <Td className="max-w-xs truncate text-xs">{r.originalValue}</Td>
              <Td className="max-w-xs truncate text-xs">{r.transformedValue}</Td>
              <Td className="text-xs text-slate-600">{r.loss}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {total > items.length && (
        <p className="mt-1 text-xs text-slate-500">
          Showing {items.length} of {fmtNumber(total)}. The export contains all of them.
        </p>
      )}
    </div>
  );
}

/** `TRUNCATE(160)` — the rule and the limit it enforces. */
function ruleLabel(l: LossyTransformationDto): string {
  return l.targetMaxLength !== null ? `${l.kind}(${l.targetMaxLength})` : l.kind;
}

/** What the count means in the rule's own terms. */
function impactSentence(l: LossyTransformationDto): string {
  if (l.affected === null) return 'The affected records have not been counted yet.';
  const n = fmtNumber(l.affected);
  switch (l.kind) {
    case 'TRUNCATE':
      return `${n} records will be truncated.`;
    case 'SUBSTRING':
      return `${n} records will be shortened.`;
    case 'TO_DATE':
      return `${n} records will lose their time of day.`;
    case 'TO_INTEGER':
      return `${n} records will lose their decimal digits.`;
    case 'TO_DECIMAL':
      return `${n} records will be rounded.`;
    default:
      return `${n} records will lose information.`;
  }
}

/** Never let an estimate read as a fact. */
function basisNote(l: LossyTransformationDto): string {
  if (l.basis === null) return 'Not measured yet. Run a preflight to count the affected records.';
  if (l.basis === 'SAMPLED') {
    return `SAMPLED or ESTIMATED: counted over ${fmtNumber(l.examined ?? 0)} record(s), so this is a floor rather than a total.`;
  }
  return l.fromPreflight
    ? 'EXACT: the preflight examined every record.'
    : 'EXACT: every record was examined.';
}
