import type { ChoiceMapEntryDto, FieldMappingDto, MigrationPlanDto } from '@shared/domain';
import type { OptionMeta } from '@shared/metadata';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, ErrorState, Modal, Pill, Select, Spinner, Table, Td, Th } from './ui';
import { get, patch } from '../lib/api';
import { fmtNumber } from '../lib/format';

interface SourceValues {
  field: string;
  scanned: number;
  sampled: boolean;
  values: { value: string; occurrences: number }[];
}

/**
 * Pairs the values a source column actually holds with the target's choices.
 *
 * The list of source values comes from the data, not from a guess, and a value with no target
 * choice stays unmapped — which blocks the plan until someone decides what it should become or
 * excludes it explicitly.
 */
export function ChoiceMappingModal({
  plan,
  entityId,
  mapping,
  targetOptions,
  open,
  onClose,
  onPlan,
}: {
  plan: MigrationPlanDto;
  entityId: string;
  mapping: FieldMappingDto;
  targetOptions: OptionMeta[];
  open: boolean;
  onClose: () => void;
  onPlan: (p: MigrationPlanDto) => void;
}) {
  const [entries, setEntries] = useState<ChoiceMapEntryDto[]>(mapping.choiceMap?.entries ?? []);
  const [defaultValue, setDefaultValue] = useState<number | null>(
    mapping.choiceMap?.defaultTargetValue ?? null,
  );

  const values = useQuery({
    queryKey: ['source-values', plan.id, entityId, mapping.sourceField],
    queryFn: () =>
      get<SourceValues>(`/api/plans/${plan.id}/entities/${entityId}/values/${mapping.sourceField}`),
    enabled: open,
  });

  // Merge the values found in the data with whatever was already mapped, suggesting a target
  // whose label matches the source value exactly. A near-match is never assumed.
  useEffect(() => {
    if (!values.data) return;
    setEntries((current) => {
      const byValue = new Map(current.map((e) => [e.sourceValue.toLowerCase(), e]));
      const merged: ChoiceMapEntryDto[] = values.data!.values.map((v) => {
        const existing = byValue.get(v.value.toLowerCase());
        if (existing) return { ...existing, occurrences: v.occurrences };
        const exact = targetOptions.find((o) => o.label.toLowerCase() === v.value.toLowerCase());
        return {
          sourceValue: v.value,
          targetValue: exact?.value ?? null,
          targetLabel: exact?.label ?? null,
          status: exact ? 'AUTO_SUGGESTED' : 'UNMAPPED',
          occurrences: v.occurrences,
        };
      });
      for (const e of current) {
        if (!merged.some((m) => m.sourceValue.toLowerCase() === e.sourceValue.toLowerCase())) merged.push(e);
      }
      return merged;
    });
  }, [values.data, targetOptions]);

  const save = useMutation({
    mutationFn: () =>
      patch<MigrationPlanDto>(`/api/plans/${plan.id}/mappings/${mapping.id}/choice-map`, {
        entries: entries.map((e) => ({
          sourceValue: e.sourceValue,
          targetValue: e.targetValue,
          targetLabel: e.targetLabel,
          status: e.status === 'AUTO_SUGGESTED' && e.targetValue !== null ? 'CONFIRMED' : e.status,
        })),
        defaultTargetValue: defaultValue,
      }),
    onSuccess: (p) => {
      onPlan(p);
      onClose();
    },
  });

  const setEntry = (sourceValue: string, targetValue: number | null, status: ChoiceMapEntryDto['status']) =>
    setEntries((current) =>
      current.map((e) =>
        e.sourceValue === sourceValue
          ? {
              ...e,
              targetValue,
              targetLabel: targetOptions.find((o) => o.value === targetValue)?.label ?? null,
              status,
            }
          : e,
      ),
    );

  const unmapped = entries.filter((e) => e.targetValue === null && e.status !== 'IGNORED').length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Choice mapping — ${mapping.sourceDisplayName} → ${mapping.targetField}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => save.mutate()}
            data-testid="save-choice-map"
          >
            Save mapping
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">
          The source stores text; the target stores a choice. Pair each value with the choice it becomes.
          {unmapped > 0 && defaultValue === null && (
            <span className="ml-1 font-medium text-amber-800">
              {unmapped} value(s) are still unmapped and will block the plan.
            </span>
          )}
        </p>

        {values.isLoading && <Spinner label="Reading the values in the source column…" />}
        {values.error && <ErrorState error={values.error} />}
        {values.data?.sampled && (
          <p className="text-xs text-amber-800">
            Values were read from the first {fmtNumber(values.data.scanned)} records; a rare value further in
            the table may not be listed here. Preflight checks every record.
          </p>
        )}

        {entries.length > 0 && (
          <Table className="max-h-80 overflow-y-auto">
            <thead>
              <tr>
                <Th>Source value</Th>
                <Th className="text-right">Records</Th>
                <Th>Target choice</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.sourceValue} data-testid={`choice-row-${e.sourceValue}`}>
                  <Td>{e.sourceValue}</Td>
                  <Td className="text-right tabular-nums">{fmtNumber(e.occurrences ?? null)}</Td>
                  <Td>
                    <Select
                      label={`Target choice for ${e.sourceValue}`}
                      value={e.targetValue === null ? '' : String(e.targetValue)}
                      onChange={(v) =>
                        setEntry(
                          e.sourceValue,
                          v === '' ? null : Number(v),
                          v === '' ? 'UNMAPPED' : 'CONFIRMED',
                        )
                      }
                      options={[
                        { value: '', label: '— not mapped —' },
                        ...targetOptions.map((o) => ({ value: String(o.value), label: o.label })),
                      ]}
                    />
                  </Td>
                  <Td>
                    {e.status === 'IGNORED' ? (
                      <Pill tone="slate">excluded</Pill>
                    ) : e.targetValue !== null ? (
                      <Pill tone="teal">mapped</Pill>
                    ) : (
                      <Pill tone="amber">unmapped</Pill>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setEntry(
                          e.sourceValue,
                          e.status === 'IGNORED' ? e.targetValue : null,
                          e.status === 'IGNORED' ? 'UNMAPPED' : 'IGNORED',
                        )
                      }
                    >
                      {e.status === 'IGNORED' ? 'Include' : 'Exclude'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <div className="flex items-center gap-2">
          <Select
            label="Default choice for anything unmapped"
            value={defaultValue === null ? '' : String(defaultValue)}
            onChange={(v) => setDefaultValue(v === '' ? null : Number(v))}
            options={[
              { value: '', label: 'No default — report unmapped values as issues' },
              ...targetOptions.map((o) => ({ value: String(o.value), label: o.label })),
            ]}
          />
        </div>
        {save.error && <ErrorState error={save.error} />}
      </div>
    </Modal>
  );
}
