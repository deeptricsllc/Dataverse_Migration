import type { TableCandidateDto, TableCategory } from '@shared/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { put } from '../lib/api';
import { fmtNumber } from '../lib/format';
import {
  Callout,
  Checkbox,
  EmptyState,
  Mono,
  Pill,
  SearchInput,
  Select,
  StatusBadge,
  Table,
  Td,
  Th,
} from './ui';

const PLATFORM = new Set([
  'systemuser',
  'team',
  'businessunit',
  'organization',
  'transactioncurrency',
  'calendar',
  'queue',
  'principal',
]);

type Filter = 'ALL' | 'SELECTED' | 'CUSTOM' | 'CONFIGURATION' | 'ISSUES' | 'ANALYZED';

export function TableSelector({
  candidates,
  selected,
  onChange,
  order,
  queryKey,
}: {
  candidates: TableCandidateDto[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Migration order from a generated plan, when available. */
  order?: Map<string, number>;
  queryKey: unknown[];
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('ANALYZED');
  const byName = useMemo(() => new Map(candidates.map((c) => [c.logicalName, c])), [candidates]);

  const setCategory = useMutation({
    mutationFn: ({ table, category }: { table: string; category: TableCategory | null }) =>
      put(`/api/table-categories/${table}`, { category }),
    onSuccess: (_d, v) => {
      qc.setQueryData<TableCandidateDto[]>(queryKey, (old) =>
        old?.map((c) => (c.logicalName === v.table ? { ...c, category: v.category } : c)),
      );
    },
  });

  const analyzedCount = candidates.filter((c) => c.sourceCount !== null).length;
  const effectiveFilter = filter === 'ANALYZED' && analyzedCount === 0 ? 'ALL' : filter;
  const rows = candidates.filter((c) => {
    if (!`${c.logicalName} ${c.displayName}`.toLowerCase().includes(search.toLowerCase())) return false;
    switch (effectiveFilter) {
      case 'SELECTED':
        return selected.has(c.logicalName);
      case 'CUSTOM':
        return c.isCustom;
      case 'CONFIGURATION':
        return c.category === 'CONFIGURATION' || c.category === 'REFERENCE';
      case 'ISSUES':
        return (
          c.schemaStatus === 'INCOMPATIBLE' ||
          c.schemaStatus === 'SOURCE_ONLY' ||
          c.schemaStatus === 'DIFFERENT'
        );
      case 'ANALYZED':
        return c.sourceCount !== null || selected.has(c.logicalName);
      default:
        return true;
    }
  });

  // Dependencies of selected tables that are not selected (explicit, never auto-selected).
  const missing = useMemo(() => {
    const out: { table: string; requires: { table: string; attribute: string; required: boolean }[] }[] = [];
    for (const name of [...selected].sort()) {
      const c = byName.get(name);
      if (!c) continue;
      const requires = c.lookups.flatMap((l) =>
        l.targets
          .filter((t) => t !== name && !selected.has(t) && !PLATFORM.has(t) && byName.has(t))
          .map((t) => ({ table: t, attribute: l.attribute, required: l.required })),
      );
      if (requires.length) out.push({ table: name, requires });
    }
    return out;
  }, [selected, byName]);

  const platformRefs = (c: TableCandidateDto) => [
    ...new Set(c.lookups.flatMap((l) => l.targets.filter((t) => PLATFORM.has(t)))),
  ];
  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.logicalName));
  const someVisibleSelected = rows.some((r) => selected.has(r.logicalName));

  const toggle = (name: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(name);
    else next.delete(name);
    onChange(next);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search tables" />
        <Select
          label="Filter tables"
          value={effectiveFilter}
          onChange={(v) => setFilter(v as Filter)}
          options={[
            { value: 'ANALYZED', label: `Analyzed tables (${analyzedCount})` },
            { value: 'ALL', label: `All tables (${candidates.length})` },
            { value: 'SELECTED', label: `Selected (${selected.size})` },
            { value: 'CUSTOM', label: 'Custom tables' },
            { value: 'CONFIGURATION', label: 'Configuration / reference data' },
            { value: 'ISSUES', label: 'With schema differences' },
          ]}
        />
        <span className="ml-auto text-sm text-slate-600">
          <strong>{selected.size}</strong> selected
        </span>
      </div>

      {missing.length > 0 && (
        <Callout tone="warning" title="Selected tables depend on tables that are not selected">
          <ul className="mt-1 space-y-1.5">
            {missing.map((m) => (
              <li key={m.table} data-testid={`dependency-hint-${m.table}`}>
                <span className="font-semibold">{byName.get(m.table)?.displayName ?? m.table}</span> requires:{' '}
                {m.requires.map((r, i) => (
                  <span key={r.table + r.attribute}>
                    {i > 0 && ', '}
                    <span className="font-medium">{byName.get(r.table)?.displayName ?? r.table}</span>{' '}
                    <span className="text-xs">
                      (via <Mono>{r.attribute}</Mono>
                      {r.required ? ', required' : ', optional'})
                    </span>{' '}
                    <button
                      type="button"
                      className="inline-flex items-center gap-0.5 text-xs font-medium text-brand-700 underline"
                      onClick={() => toggle(r.table, true)}
                    >
                      <Plus className="h-3 w-3" /> add
                    </button>
                  </span>
                ))}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            Without them, references resolve only to records that already exist in the target (by identifier);
            unresolved optional lookups are left empty and required ones fail.
          </p>
        </Callout>
      )}

      {rows.length === 0 ? (
        <EmptyState title="No tables match" description="Adjust the search or filter." />
      ) : (
        <Table className="rounded-md border border-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th className="w-10">
                <Checkbox
                  label="Select all visible tables"
                  checked={allVisibleSelected}
                  indeterminate={!allVisibleSelected && someVisibleSelected}
                  onChange={(on) => {
                    const next = new Set(selected);
                    for (const r of rows) {
                      if (on && r.schemaStatus !== 'SOURCE_ONLY') next.add(r.logicalName);
                      if (!on) next.delete(r.logicalName);
                    }
                    onChange(next);
                  }}
                />
              </Th>
              {order && <Th>Order</Th>}
              <Th>Table</Th>
              <Th>Category</Th>
              <Th className="text-right">Source rows</Th>
              <Th className="text-right">Target rows</Th>
              <Th>Schema</Th>
              <Th>Dependencies</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((c) => {
              const deps = [
                ...new Set(
                  c.lookups.flatMap((l) => l.targets.filter((t) => t !== c.logicalName && !PLATFORM.has(t))),
                ),
              ];
              const self = c.lookups.some((l) => l.targets.includes(c.logicalName));
              const platform = platformRefs(c);
              return (
                <tr
                  key={c.logicalName}
                  className={selected.has(c.logicalName) ? 'bg-brand-50/40' : undefined}
                  data-testid={`table-row-${c.logicalName}`}
                >
                  <Td>
                    <Checkbox
                      label={`Select ${c.displayName}`}
                      checked={selected.has(c.logicalName)}
                      onChange={(on) => toggle(c.logicalName, on)}
                    />
                  </Td>
                  {order && (
                    <Td className="tabular-nums text-slate-500">{order.get(c.logicalName) ?? '—'}</Td>
                  )}
                  <Td>
                    <div className="font-medium text-slate-900">{c.displayName}</div>
                    <Mono>{c.logicalName}</Mono> {c.isCustom && <Pill>custom</Pill>}
                  </Td>
                  <Td>
                    <select
                      aria-label={`Category for ${c.displayName}`}
                      value={c.category ?? ''}
                      onChange={(e) =>
                        setCategory.mutate({
                          table: c.logicalName,
                          category: (e.target.value || null) as TableCategory | null,
                        })
                      }
                      className="rounded border border-slate-200 bg-white py-0.5 pl-1.5 pr-6 text-xs"
                    >
                      <option value="">—</option>
                      <option value="CONFIGURATION">Configuration</option>
                      <option value="REFERENCE">Reference</option>
                      <option value="TRANSACTIONAL">Transactional</option>
                    </select>
                  </Td>
                  <Td className="text-right tabular-nums">{fmtNumber(c.sourceCount)}</Td>
                  <Td className="text-right tabular-nums">{fmtNumber(c.targetCount)}</Td>
                  <Td>
                    {c.schemaStatus ? (
                      <StatusBadge status={c.schemaStatus} />
                    ) : (
                      <span className="text-xs text-slate-400">not analyzed</span>
                    )}
                  </Td>
                  <Td className="text-xs text-slate-600">
                    {deps.length === 0 && !self && platform.length === 0 && (
                      <span className="text-slate-400">None</span>
                    )}
                    {deps.length > 0 && (
                      <div>
                        Requires:{' '}
                        {deps.map((d, i) => (
                          <span key={d} className={selected.has(d) ? 'text-emerald-700' : 'text-amber-700'}>
                            {i > 0 && ', '}
                            {byName.get(d)?.displayName ?? d}
                            {!selected.has(d) && (
                              <AlertTriangle className="ml-0.5 inline h-3 w-3" aria-label="not selected" />
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                    {self && <div className="text-slate-500">Self-referencing</div>}
                    {platform.length > 0 && (
                      <div className="text-slate-400">Resolved in target: {platform.join(', ')}</div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {setCategory.error && <p className="text-xs text-red-700">{(setCategory.error as Error).message}</p>}
    </div>
  );
}
