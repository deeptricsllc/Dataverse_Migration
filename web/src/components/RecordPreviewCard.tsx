import type { MigrationPlanDto, PreflightAction, PreviewRecordDto } from '@shared/domain';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ErrorState, Mono, Pill, Spinner, Table, Td, Th } from './ui';
import { get } from '../lib/api';

const ACTION_TONE: Record<PreflightAction, 'teal' | 'blue' | 'slate' | 'amber' | 'red'> = {
  CREATE: 'teal',
  UPDATE: 'blue',
  UNCHANGED: 'slate',
  CONFLICT: 'amber',
  BLOCKED: 'red',
};

/**
 * What a handful of real records become: the source value, the value after the transformation
 * pipeline, and what the target holds today — plus the action that follows from comparing the
 * last two. Read-only, and computed by the same engine the migration uses.
 */
export function RecordPreviewCard({ plan, entityId }: { plan: MigrationPlanDto; entityId: string }) {
  const [open, setOpen] = useState(false);
  const preview = useQuery({
    queryKey: ['record-preview', plan.id, entityId],
    queryFn: () => get<PreviewRecordDto[]>(`/api/plans/${plan.id}/entities/${entityId}/preview?limit=5`),
    enabled: open,
  });

  return (
    <Card
      title="Before and after"
      subtitle="A few real records, transformed. Nothing is written."
      data-testid="record-preview"
      actions={
        <Button size="sm" onClick={() => setOpen(!open)} data-testid="toggle-record-preview">
          {open ? 'Hide' : 'Show preview'}
        </Button>
      }
    >
      {!open && (
        <p className="text-sm text-slate-500">
          Shows each mapped field as it is in the source, what the transformations make of it, and what the
          target holds today.
        </p>
      )}
      {open && preview.isLoading && <Spinner label="Transforming a sample…" />}
      {open && preview.error && <ErrorState error={preview.error} onRetry={() => preview.refetch()} />}
      {open &&
        preview.data?.map((record) => (
          <div key={record.sourceRecordId} className="mb-4 last:mb-0">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-slate-900">{record.recordName ?? '(no name)'}</span>
              <Mono className="text-[11px] text-slate-400">{record.sourceRecordId}</Mono>
              <Pill tone={ACTION_TONE[record.action]}>{record.action}</Pill>
              {record.reason && <span className="text-xs text-slate-500">{record.reason}</span>}
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Field</Th>
                  <Th>Source</Th>
                  <Th>Transformed</Th>
                  <Th>Target today</Th>
                </tr>
              </thead>
              <tbody>
                {record.fields.map((f) => (
                  <tr key={f.field} className={f.changed ? 'bg-brand-50/50' : undefined}>
                    <Td>
                      <Mono className="text-[11px]">{f.field}</Mono>
                      {f.applied.length > 0 && (
                        <div className="text-[10px] text-slate-500">
                          {f.applied.map((a) => a.kind.toLowerCase().replace(/_/g, ' ')).join(' → ')}
                        </div>
                      )}
                    </Td>
                    <Td>{renderValue(f.sourceValue)}</Td>
                    <Td>{renderValue(f.transformedValue)}</Td>
                    <Td>{renderValue(f.targetValue)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ))}
    </Card>
  );
}

function renderValue(value: string | null) {
  if (value === null) return <span className="text-slate-400">NULL</span>;
  if (value === '') return <span className="text-slate-400">(empty)</span>;
  // Quoted, so leading and trailing spaces are visible.
  return <span className="font-mono text-xs">&quot;{value}&quot;</span>;
}
