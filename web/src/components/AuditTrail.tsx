import {
  auditCategory,
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_LABELS,
  type AuditEventDto,
  type AuditPageDto,
} from '@shared/domain';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Mono,
  SearchInput,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from './ui';
import { get, qs } from '../lib/api';
import { humanize } from '../lib/format';

/**
 * The audit trail, as its own thing.
 *
 * It used to live inside Settings, which is where a feature goes when nobody has decided what it is. An
 * audit trail is not a setting — it is the record somebody consults when they are asked what happened, and
 * a reader who has been told "the platform keeps an audit trail" looks for it in the navigation and finds
 * Settings. The first step of the information-architecture recommendation is precisely this: Audit and Team
 * become destinations, and nothing else moves.
 *
 * Extracted rather than copied, so there is one audit view and not two that drift.
 */

/** Owns the filters and the query, so a page is three lines. */
export function useAuditTrail() {
  const [filters, setFilters] = useState<AuditFilters>({
    category: '',
    outcome: '',
    user: '',
    search: '',
    days: '',
  });
  const page = useQuery({
    queryKey: ['audit', filters],
    queryFn: () =>
      get<AuditPageDto>(
        `/api/audit${qs({
          category: filters.category || undefined,
          outcome: filters.outcome || undefined,
          user: filters.user || undefined,
          search: filters.search || undefined,
          days: filters.days || undefined,
        })}`,
      ),
  });
  return { filters, setFilters, page };
}

const DAY_OPTIONS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '', label: 'Everything' },
];

export interface AuditFilters {
  category: string;
  outcome: string;
  user: string;
  search: string;
  days: string;
}

function summariseAudit(details: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === undefined) continue;
    if (parts.length >= 3) break;
    const label = humanize(key).toLowerCase();
    if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${label} ${value}`);
    else if (typeof value === 'string') parts.push(value.length <= 40 ? `${label} ${value}` : label);
    else if (Array.isArray(value)) parts.push(`${value.length} ${label}`);
    else parts.push(label);
  }
  const more = Object.keys(details).length - parts.length;
  return parts.length ? `${parts.join(' · ')}${more > 0 ? ` · +${more} more` : ''}` : 'details';
}

function AuditDetails({ details }: { details: Record<string, unknown> | null }) {
  const [open, setOpen] = useState(false);
  if (!details || Object.keys(details).length === 0) return <>—</>;
  const summary = summariseAudit(details);
  return (
    <div>
      <button
        type="button"
        className="text-left hover:underline"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Hide the recorded values' : 'Show the recorded values'}
      >
        {summary}
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-50 p-2 font-mono text-[10px] leading-relaxed text-slate-600">
          {JSON.stringify(details, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function AuditTrailCard({
  page,
  loading,
  fetching,
  error,
  filters,
  onFilters,
}: {
  page: AuditPageDto | undefined;
  loading: boolean;
  /** A filter changed and the new page has not arrived. The old one is still on screen. */
  fetching: boolean;
  error: unknown;
  filters: AuditFilters;
  onFilters: (f: AuditFilters) => void;
}) {
  const set = (patch: Partial<AuditFilters>) => onFilters({ ...filters, ...patch });
  const groups = useMemo(() => {
    const byDay = new Map<string, AuditEventDto[]>();
    for (const item of page?.items ?? []) {
      const day = new Date(item.createdAt).toDateString();
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(item);
    }
    return [...byDay.entries()];
  }, [page]);

  const filtered = Boolean(filters.category || filters.outcome || filters.user || filters.search.trim());
  const clearAll = () => onFilters({ category: '', outcome: '', user: '', search: '', days: '30' });

  return (
    <Card
      title="Audit trail"
      subtitle="Every recorded action, with the actor, the environments and the options."
      bodyClassName="p-0"
      data-testid="audit-trail"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={filters.search}
            onChange={(search) => set({ search })}
            placeholder="Search actions and details"
          />
          <select
            aria-label="Filter by activity"
            className="rounded border border-slate-300 px-2 py-1 text-xs"
            value={filters.category}
            onChange={(e) => set({ category: e.target.value })}
          >
            <option value="">All activity</option>
            {AUDIT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {AUDIT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by outcome"
            className="rounded border border-slate-300 px-2 py-1 text-xs"
            value={filters.outcome}
            onChange={(e) => set({ outcome: e.target.value })}
          >
            <option value="">Any outcome</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILURE">Failure</option>
            <option value="REQUESTED">Requested</option>
          </select>
          <select
            aria-label="Filter by user"
            className="rounded border border-slate-300 px-2 py-1 text-xs"
            value={filters.user}
            onChange={(e) => set({ user: e.target.value })}
          >
            <option value="">Anyone</option>
            {(page?.users ?? []).map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by period"
            className="rounded border border-slate-300 px-2 py-1 text-xs"
            value={filters.days}
            onChange={(e) => set({ days: e.target.value })}
          >
            {DAY_OPTIONS.map((d) => (
              <option key={d.label} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {loading && !page && <Spinner />}
      {Boolean(error) && (
        <div className="p-4">
          <ErrorState error={error} />
        </div>
      )}
      {page && page.items.length === 0 && (
        <EmptyState
          title="Nothing matches"
          description={
            filtered
              ? 'No events match these filters. Widen the period or clear a filter.'
              : 'No activity has been recorded in this period yet.'
          }
          action={filtered ? <Button onClick={clearAll}>Clear filters</Button> : undefined}
        />
      )}
      {page && page.items.length > 0 && (
        // Keeping the previous page visible while the next one loads avoids the list collapsing on
        // every keystroke, but rows that no longer match the filter are then briefly still there.
        // Dimming them says so rather than letting it look like the filter did nothing.
        <div className={fetching ? 'opacity-50 transition-opacity' : undefined} aria-busy={fetching}>
          <Table>
            <thead className="bg-slate-50">
              <tr>
                <Th>Time</Th>
                <Th>User</Th>
                <Th>Action</Th>
                <Th>Outcome</Th>
                <Th>Source</Th>
                <Th>Target</Th>
                <Th>Run / object</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {groups.map(([day, items]) => (
                <Fragment key={day}>
                  <tr className="bg-slate-50/80">
                    <td colSpan={8} className="px-4 py-1.5 text-xs font-semibold text-slate-600">
                      {day} · {items.length} event{items.length === 1 ? '' : 's'}
                    </td>
                  </tr>
                  {items.map((a) => (
                    <tr key={a.id}>
                      <Td className="whitespace-nowrap text-xs text-slate-500">
                        {new Date(a.createdAt).toLocaleTimeString()}
                      </Td>
                      <Td className="text-xs">{a.user ?? '—'}</Td>
                      <Td className="text-xs font-medium">
                        {humanize(a.action)}
                        <div
                          className="text-[10px] font-normal uppercase tracking-wide text-slate-400"
                          data-testid="audit-category"
                        >
                          {AUDIT_CATEGORY_LABELS[auditCategory(a.action)]}
                        </div>
                      </Td>
                      <Td>
                        <StatusBadge
                          status={
                            a.outcome === 'SUCCESS' ? 'PASS' : a.outcome === 'FAILURE' ? 'FAIL' : 'QUEUED'
                          }
                          label={a.outcome.toLowerCase()}
                        />
                      </Td>
                      <Td className="text-xs">{a.sourceEnvironment ?? '—'}</Td>
                      <Td className="text-xs">{a.targetEnvironment ?? '—'}</Td>
                      <Td>
                        <Mono className="text-[11px]">{a.runId ? a.runId.slice(0, 8) : '—'}</Mono>
                      </Td>
                      <Td className="max-w-xs text-[11px] text-slate-500">
                        <AuditDetails details={a.details} />
                      </Td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </Table>
          <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            Showing {page.items.length.toLocaleString()} of {page.total.toLocaleString()} matching event(s)
            {page.total > page.items.length ? ' Narrow the filters to see the rest' : ''}.
          </p>
        </div>
      )}
    </Card>
  );
}
