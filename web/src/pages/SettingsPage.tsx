import {
  auditCategory,
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_LABELS,
  type AuditEventDto,
  type AuditPageDto,
} from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Modal,
  Mono,
  PageHeader,
  Pill,
  SearchInput,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../components/ui';
import { AccessRequestsCard } from '../components/AccessRequestsCard';
import { get, post, qs } from '../lib/api';
import { humanize } from '../lib/format';
import { useSession } from '../lib/session';

interface SettingsDto {
  organization: { id: string; name: string; isDemo: boolean };
  demoMode: boolean;
  microsoft: {
    enabled: boolean;
    tenant: string;
    redirectUri: string;
    clientIdConfigured: boolean;
    discoveryUrl: string;
    powerPlatformEnrichment: boolean;
  };
  safety: { businessLogicBypassAllowed: boolean; canBypass: boolean };
  database: string;
}

export function SettingsPage() {
  const { user } = useSession();
  const qc = useQueryClient();
  const [resetOpen, setResetOpen] = useState(false);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsDto>('/api/settings') });
  const [filters, setFilters] = useState<AuditFilters>({
    category: '',
    outcome: '',
    user: '',
    search: '',
    days: '30',
  });
  const audit = useQuery({
    queryKey: ['audit', filters],
    queryFn: () =>
      get<AuditPageDto>(
        `/api/audit${qs({
          limit: 200,
          category: filters.category || undefined,
          outcome: filters.outcome || undefined,
          user: filters.user || undefined,
          search: filters.search.trim() || undefined,
          days: filters.days || undefined,
        })}`,
      ),
    placeholderData: (prev) => prev,
  });
  const reset = useMutation({
    mutationFn: () => post('/api/demo/reset'),
    onSuccess: () => {
      setResetOpen(false);
      void qc.invalidateQueries();
    },
  });

  return (
    <>
      <PageHeader
        title="Settings"
        description="Account, integration and safety configuration, plus the organization audit trail."
      />
      {settings.isLoading && <Spinner />}
      {settings.error && <ErrorState error={settings.error} />}
      {settings.data && (
        <div className="mb-6 grid gap-5 lg:grid-cols-3">
          <Card title="Account">
            <dl className="space-y-2 text-sm">
              <Row label="Name" value={user.displayName} />
              <Row label="Email" value={user.email ?? '—'} />
              <Row label="Role" value={user.role === 'ADMIN' ? 'Administrator' : 'Member'} />
              <Row label="Organization" value={settings.data.organization.name} />
              <Row
                label="Sign-in"
                value={user.authProvider === 'demo' ? 'Demo account' : 'Microsoft Entra ID'}
              />
            </dl>
          </Card>
          <Card title="Microsoft integration">
            <dl className="space-y-2 text-sm">
              <Row
                label="Status"
                value={
                  <StatusBadge
                    status={settings.data.microsoft.enabled ? 'CONNECTED' : 'UNKNOWN'}
                    label={settings.data.microsoft.enabled ? 'Configured' : 'Not configured'}
                  />
                }
              />
              <Row label="Tenant" value={<Mono>{settings.data.microsoft.tenant}</Mono>} />
              <Row
                label="Redirect URI"
                value={<Mono className="break-all">{settings.data.microsoft.redirectUri}</Mono>}
              />
              <Row
                label="Discovery"
                value={<Mono className="break-all">{settings.data.microsoft.discoveryUrl}</Mono>}
              />
              <Row
                label="Power Platform enrichment"
                value={settings.data.microsoft.powerPlatformEnrichment ? 'On' : 'Off'}
              />
            </dl>
            {!settings.data.microsoft.enabled && (
              <p className="mt-3 text-xs text-slate-500">
                Set ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET on the server. Secrets are never shown here.
              </p>
            )}
          </Card>
          <Card title="Safety">
            <dl className="space-y-2 text-sm">
              <Row
                label="Plug-in bypass"
                value={
                  settings.data.safety.businessLogicBypassAllowed ? (
                    <Pill tone="amber">allowed for admins</Pill>
                  ) : (
                    <Pill>disabled</Pill>
                  )
                }
              />
              <Row label="You can bypass" value={settings.data.safety.canBypass ? 'Yes (audited)' : 'No'} />
              <Row label="Default conflict strategy" value="Skip existing" />
              <Row label="Database" value={settings.data.database} />
            </dl>
            {settings.data.demoMode && settings.data.organization.isDemo && user.role === 'ADMIN' && (
              <div className="mt-4 border-t border-slate-100 pt-4">
                <Button variant="danger" size="sm" onClick={() => setResetOpen(true)}>
                  Reset demo environment data
                </Button>
                <p className="mt-1 text-xs text-slate-500">
                  Restores the simulated Dataverse records. Run history is kept.
                </p>
              </div>
            )}
          </Card>
        </div>
      )}

      {user.platformOperator && (
        <div className="mb-6">
          <AccessRequestsCard />
        </div>
      )}

      <AuditTrailCard
        page={audit.data}
        loading={audit.isLoading}
        fetching={audit.isFetching}
        error={audit.error}
        filters={filters}
        onFilters={setFilters}
      />

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset demo data?"
        footer={
          <>
            <Button onClick={() => setResetOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate()}>
              Reset demo data
            </Button>
          </>
        }
      >
        <Callout tone="warning">
          This affects only the simulated DEMO environments stored by this application.
        </Callout>
        {reset.error && (
          <div className="mt-3">
            <ErrorState error={reset.error} />
          </div>
        )}
      </Modal>
    </>
  );
}

interface AuditFilters {
  category: string;
  outcome: string;
  user: string;
  search: string;
  days: string;
}

const DAY_OPTIONS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '', label: 'Everything' },
];

/**
 * The audit trail, made readable.
 *
 * It was one undifferentiated list, newest first, two hundred rows long — technically complete and
 * practically unusable, because the question somebody arrives with is always narrow: what happened
 * to production yesterday, who accepted that data-loss warning. So: filters over the dimensions the
 * data already has, and grouping by day, which is how people remember events.
 *
 * The category is derived from the action name rather than stored, so no history had to be
 * back-filled for this to work.
 */
function AuditTrailCard({
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
      subtitle="Every consequential action, with who did it, against which environments and with which options."
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
                      <Td className="max-w-xs truncate text-[11px] text-slate-500">
                        {a.details ? JSON.stringify(a.details) : '—'}
                      </Td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </Table>
          <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            Showing {page.items.length.toLocaleString()} of {page.total.toLocaleString()} matching event(s)
            {page.total > page.items.length ? ' — narrow the filters to see the rest' : ''}.
          </p>
        </div>
      )}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-800">{value}</dd>
    </div>
  );
}
