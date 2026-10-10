import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { EnvironmentDto } from '@shared/domain';
import type { TableSummary } from '@shared/metadata';
import { Button, ErrorState, Spinner } from './ui';
import { api } from '../lib/api';

/**
 * What is in a connection, and which of it you want.
 *
 * One component, two callers. Adding datasets to an analysis project and choosing a migration's scope are
 * the same question asked about the same catalog — "which of these tables do you mean" — and building
 * that twice is how the two screens drift until one of them groups by schema and the other does not.
 *
 * Deliberately knows nothing about what the selection is for. It reads the catalog, lets somebody
 * search and tick, and hands back logical names; the caller decides whether that becomes a project source
 * or a migration's scope.
 *
 * No row counts here, on purpose: counting every table to draw a list would be a hundred queries to
 * answer a question nobody has asked yet. The preview counts the one that was chosen.
 */
export function ObjectPicker({
  connection,
  chosen,
  onToggle,
  onPreview,
  emptyLabel = 'Objects',
}: {
  connection: EnvironmentDto | { id: string; connectionType: string };
  chosen: Set<string>;
  onToggle: (logicalName: string) => void;
  /** Offered per row when the caller can show one. Omitted where there is nothing to preview with. */
  onPreview?: (logicalName: string) => void;
  /** What to call the group when the provider has no schemas to group by. */
  emptyLabel?: string;
}) {
  const [filter, setFilter] = useState('');
  const tables = useQuery({
    queryKey: ['environment-tables', connection.id],
    queryFn: () => api<TableSummary[]>('GET', `/api/environments/${connection.id}/tables`),
  });

  if (tables.isLoading) return <Spinner label="Reading what is in it…" />;
  if (tables.error) return <ErrorState error={tables.error} />;

  const all = tables.data ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? all.filter((t) =>
        [t.logicalName, t.displayName, t.sqlSchema].some((v) =>
          String(v ?? '')
            .toLowerCase()
            .includes(needle),
        ),
      )
    : all;

  /** Grouped by schema, which is how somebody who knows the database thinks about it. */
  const groups = new Map<string, TableSummary[]>();
  for (const table of shown) {
    const key = table.sqlSchema ?? (connection.connectionType === 'DATAVERSE' ? 'Tables' : emptyLabel);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(table);
  }

  return (
    <div className="space-y-4">
      <label className="relative block">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search tables"
          aria-label="Search tables"
          data-testid="table-search"
          className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </label>

      {/*
        One scrollbar. Giving this list its own made the panel scroll inside the panel: you scrolled, the
        wrong pane moved, and a row sat clipped in half at the top of the inner one.
      */}
      <div className="space-y-4">
        {[...groups.entries()].map(([schema, inSchema]) => (
          <section key={schema}>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{schema}</h4>
            <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
              {inSchema.map((table) => (
                <li
                  key={table.logicalName}
                  data-testid={`object-row-${table.logicalName}`}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(table.logicalName)}
                    onChange={() => onToggle(table.logicalName)}
                    aria-label={`Add ${table.logicalName}`}
                    data-testid={`object-${table.logicalName}`}
                    className="h-4 w-4 flex-none rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-900">{table.logicalName}</span>
                    {table.displayName !== table.logicalName && (
                      <span className="block truncate text-xs text-slate-500">{table.displayName}</span>
                    )}
                  </span>
                  {table.isView && (
                    <span className="flex-none rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      View
                    </span>
                  )}
                  {onPreview && (
                    <Button size="sm" variant="ghost" onClick={() => onPreview(table.logicalName)}>
                      Preview
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {shown.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-500">Nothing matches “{filter}”.</p>
        )}
      </div>
    </div>
  );
}
