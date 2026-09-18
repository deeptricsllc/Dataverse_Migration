import type {
  ConnectionTestResultDto,
  ConnectionType,
  ConnectorCapabilities,
  EnvironmentDto,
} from '@shared/domain';
import { CONNECTION_TYPE_LABELS } from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Cloud,
  Database,
  Globe,
  MapPin,
  Minus,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConnectionModal } from '../components/ConnectionForm';
import { WizardSteps } from '../components/WizardSteps';
import {
  Button,
  Callout,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  Pill,
  SearchInput,
  Select,
  Spinner,
  StatusBadge,
  cx,
} from '../components/ui';
import { api, get, post } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { useSession, useWorkspace } from '../lib/session';

const TYPE_ICONS: Record<ConnectionType, typeof Database> = {
  DATAVERSE: Database,
  SQL_SERVER: Server,
  AZURE_SQL: Cloud,
};

const TYPE_TONES: Record<ConnectionType, 'violet' | 'blue' | 'teal'> = {
  DATAVERSE: 'violet',
  SQL_SERVER: 'blue',
  AZURE_SQL: 'teal',
};

/** Capabilities shown on every card. Read from the connector, never inferred from the provider. */
const CAPABILITIES: [keyof ConnectorCapabilities, string, string][] = [
  ['supportsRead', 'Read', 'Reads tables and records'],
  ['supportsWrite', 'Write', 'Can be used as a migration target'],
  ['supportsTransactions', 'Transactions', 'Groups writes so a failed batch can be rolled back'],
  ['supportsOwnership', 'Ownership', 'Records have an owner the migration can set'],
  ['supportsAuditImpersonation', 'Audit attribution', 'Created by / modified by can be preserved'],
];

function CapabilityList({ capabilities }: { capabilities: ConnectorCapabilities }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-1" aria-label="Capabilities">
      {CAPABILITIES.map(([key, label, help]) => {
        const supported = capabilities[key];
        return (
          <li key={key}>
            <Pill
              tone={supported ? 'teal' : 'slate'}
              title={`${help} — ${supported ? 'supported' : 'not supported'}`}
            >
              {supported ? (
                <Check className="mr-1 h-3 w-3" aria-hidden />
              ) : (
                <Minus className="mr-1 h-3 w-3" aria-hidden />
              )}
              {label}
            </Pill>
          </li>
        );
      })}
    </ul>
  );
}

function ConnectionDetails({ env }: { env: EnvironmentDto }) {
  if (env.sql) {
    return (
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <dt className="flex items-center gap-1 text-slate-500">
          <Server className="h-3 w-3" /> Server
        </dt>
        <dd className="truncate text-slate-700" title={`${env.sql.host}:${env.sql.port}`}>
          {env.sql.host}:{env.sql.port}
        </dd>
        <dt className="text-slate-500">Database</dt>
        <dd className="truncate text-slate-700">{env.sql.database}</dd>
        <dt className="text-slate-500">Schemas</dt>
        <dd className="truncate text-slate-700">
          {env.sql.schemas.length ? env.sql.schemas.join(', ') : 'All readable'}
        </dd>
        <dt className="text-slate-500">Encryption</dt>
        <dd className="text-slate-700">
          {env.sql.encrypt ? 'Encrypted' : 'Not encrypted'}
          {env.sql.trustServerCertificate && ' · certificate trusted'}
        </dd>
      </dl>
    );
  }
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
      <dt className="flex items-center gap-1 text-slate-500">
        <Globe className="h-3 w-3" /> Type
      </dt>
      <dd className="text-slate-700">{env.environmentType ?? '—'}</dd>
      <dt className="flex items-center gap-1 text-slate-500">
        <MapPin className="h-3 w-3" /> Region
      </dt>
      <dd className="text-slate-700">{env.region ?? '—'}</dd>
      <dt className="text-slate-500">Dataverse</dt>
      <dd className="text-slate-700">
        {env.dataverseAvailable ? `Available${env.version ? ` · v${env.version}` : ''}` : 'Not available'}
      </dd>
      <dt className="text-slate-500">Identifier</dt>
      <dd className="truncate font-mono text-slate-600" title={env.organizationId ?? env.uniqueName ?? ''}>
        {env.organizationId ?? env.uniqueName ?? '—'}
      </dd>
    </dl>
  );
}

/**
 * Deletion removes the connection settings and its stored credential only: what a migration did
 * stays in the history, which is why a referenced connection is refused rather than cascaded.
 */
function DeleteConnectionModal({
  connection,
  onClose,
  onDeleted,
}: {
  connection: EnvironmentDto;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => api<{ deleted: true }>('DELETE', `/api/connections/${connection.id}`),
    onSuccess: onDeleted,
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Delete ${connection.displayName}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            icon={<Trash2 className="h-4 w-4" />}
            loading={remove.isPending}
            onClick={() => remove.mutate()}
            data-testid="confirm-delete-connection"
          >
            Delete connection
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <p>
          The connection settings and its stored password are removed. Migration history is preserved: every
          run, validation and record mapping that used this connection keeps its records.
        </p>
        <p>
          A connection that a migration plan or run still references cannot be deleted, because deleting it
          would leave that history pointing at nothing.
        </p>
        {remove.error && <ErrorState error={remove.error} />}
      </div>
    </Modal>
  );
}

export function EnvironmentsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useSession();
  const workspace = useWorkspace();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [kindFilter, setKindFilter] = useState('ALL');
  const [editing, setEditing] = useState<EnvironmentDto | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<EnvironmentDto | null>(null);

  const envs = useQuery({
    queryKey: ['environments'],
    queryFn: () => get<EnvironmentDto[]>('/api/environments'),
  });
  const discover = useMutation({
    mutationFn: () => post<EnvironmentDto[]>('/api/environments/discover'),
    onSuccess: (data) => {
      qc.setQueryData(['environments'], data);
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
  });
  // Dataverse and SQL connections are tested by different endpoints; only the Dataverse one
  // returns the updated connection, so the SQL result is picked up by refetching.
  const test = useMutation({
    mutationFn: async (env: EnvironmentDto) => {
      if (env.connectionType === 'DATAVERSE') return post<EnvironmentDto>(`/api/environments/${env.id}/test`);
      await post<ConnectionTestResultDto>(`/api/connections/${env.id}/test`);
      return null;
    },
    onSuccess: (updated) => {
      if (updated) {
        qc.setQueryData<EnvironmentDto[]>(['environments'], (old) =>
          old?.map((e) => (e.id === updated.id ? updated : e)),
        );
      } else {
        void qc.invalidateQueries({ queryKey: ['environments'] });
      }
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
  });

  // First visit: discover automatically.
  const autoDiscover =
    envs.data && envs.data.length === 0 && !discover.isPending && !discover.isSuccess && !discover.error;
  useEffect(() => {
    if (autoDiscover) discover.mutate();
  }, [autoDiscover]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => envs.data ?? [], [envs.data]);
  const types = useMemo(
    () => ['ALL', ...new Set(list.map((e) => e.environmentType).filter((t): t is string => Boolean(t)))],
    [list],
  );
  const kinds = useMemo(
    () => ['ALL', ...new Set(list.map((e) => e.connectionType))] as (ConnectionType | 'ALL')[],
    [list],
  );
  const filtered = list.filter(
    (e) =>
      (typeFilter === 'ALL' || e.environmentType === typeFilter) &&
      (kindFilter === 'ALL' || e.connectionType === kindFilter) &&
      `${e.displayName} ${e.url} ${e.uniqueName ?? ''} ${e.sql?.database ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  const select = async (role: 'source' | 'target', env: EnvironmentDto) => {
    const next = {
      sourceEnvironmentId: workspace.source?.id ?? null,
      targetEnvironmentId: workspace.target?.id ?? null,
    };
    if (role === 'source') {
      next.sourceEnvironmentId = env.id;
      if (next.targetEnvironmentId === env.id) next.targetEnvironmentId = null;
    } else {
      next.targetEnvironmentId = env.id;
      if (next.sourceEnvironmentId === env.id) next.sourceEnvironmentId = null;
    }
    await workspace.setWorkspace(next);
  };

  const bothConnected =
    workspace.source?.connectionStatus === 'CONNECTED' && workspace.target?.connectionStatus === 'CONNECTED';

  return (
    <>
      <WizardSteps current={1} />
      <PageHeader
        title="Connections"
        description={
          user.organization.isDemo
            ? 'Simulated Dataverse environments and SQL Server databases available to the demo account.'
            : 'Dataverse environments discovered through the Microsoft Global Discovery Service, plus the SQL Server and Azure SQL databases you configure here.'
        }
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search connections" />
            <Select
              label="Filter by connection type"
              value={kindFilter}
              onChange={setKindFilter}
              options={kinds.map((k) => ({
                value: k,
                label: k === 'ALL' ? 'All connection types' : CONNECTION_TYPE_LABELS[k],
              }))}
            />
            <Select
              label="Filter by type"
              value={typeFilter}
              onChange={setTypeFilter}
              options={types.map((t) => ({ value: t, label: t === 'ALL' ? 'All types' : t }))}
            />
            <Button
              icon={<RefreshCw className="h-4 w-4" />}
              loading={discover.isPending}
              onClick={() => discover.mutate()}
            >
              Refresh environments
            </Button>
            <Button
              variant="primary"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
              data-testid="add-connection"
            >
              Add connection
            </Button>
          </>
        }
      />

      {workspace.error && (
        <div className="mb-4">
          <ErrorState error={workspace.error} />
        </div>
      )}
      {discover.error && (
        <div className="mb-4">
          <ErrorState error={discover.error} onRetry={() => discover.mutate()} />
        </div>
      )}

      {workspace.ready && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3">
          <div className="text-sm text-brand-900">
            <span className="font-semibold">{workspace.source!.displayName}</span>{' '}
            <ArrowRight className="inline h-3.5 w-3.5" />{' '}
            <span className="font-semibold">{workspace.target!.displayName}</span>
            {!bothConnected && (
              <span className="ml-2 text-brand-800">— test both connections before analyzing.</span>
            )}
          </div>
          <div className="flex gap-2">
            {!bothConnected && (
              <Button
                size="sm"
                loading={test.isPending}
                onClick={async () => {
                  await test.mutateAsync(workspace.source!);
                  await test.mutateAsync(workspace.target!);
                }}
              >
                Verify both connections
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={!bothConnected}
              onClick={() => navigate('/compare')}
            >
              Continue to Analyze
            </Button>
          </div>
        </div>
      )}

      {(envs.isLoading || (discover.isPending && list.length === 0)) && (
        <Spinner label="Discovering environments…" />
      )}
      {envs.error && <ErrorState error={envs.error} onRetry={() => envs.refetch()} />}
      {!envs.isLoading && !discover.isPending && list.length === 0 && !discover.error && (
        <EmptyState
          icon={<Database className="h-8 w-8" />}
          title="No connections yet"
          description="Discovery found no Dataverse environments your account can access. You can also add a SQL Server or Azure SQL connection by hand."
          action={<Button onClick={() => discover.mutate()}>Discover environments</Button>}
        />
      )}
      {list.length > 0 && filtered.length === 0 && <EmptyState title="No connections match your filters" />}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((env) => {
          const isSource = workspace.source?.id === env.id;
          const isTarget = workspace.target?.id === env.id;
          // Dataverse without the Dataverse API is unusable; a SQL connection always is.
          const usable = env.connectionType !== 'DATAVERSE' || env.dataverseAvailable;
          const editable = env.connectionType !== 'DATAVERSE';
          const TypeIcon = TYPE_ICONS[env.connectionType];
          return (
            <article
              key={env.id}
              data-testid={`connection-card-${env.displayName}`}
              className={cx(
                'flex flex-col rounded-lg border bg-white p-4 shadow-sm',
                isSource
                  ? 'border-[var(--color-source)] ring-1 ring-[var(--color-source)]'
                  : isTarget
                    ? 'border-[var(--color-target)] ring-1 ring-[var(--color-target)]'
                    : 'border-slate-200',
              )}
            >
              {/* Inner wrapper keeps the original env-card test hook while the card gains its own. */}
              <div data-testid={`env-card-${env.displayName}`} className="flex flex-1 flex-col">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-slate-900">{env.displayName}</h3>
                    <p className="truncate font-mono text-xs text-slate-500">{env.url}</p>
                  </div>
                  <div className="flex flex-none flex-col items-end gap-1">
                    {isSource && (
                      <span className="rounded bg-[var(--color-source-soft)] px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-[var(--color-source)]">
                        SOURCE
                      </span>
                    )}
                    {isTarget && (
                      <span className="rounded bg-[var(--color-target-soft)] px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-[var(--color-target)]">
                        TARGET
                      </span>
                    )}
                    {(env.provider === 'demo' || env.provider === 'demosql') && (
                      <Pill tone="amber">DEMO</Pill>
                    )}
                  </div>
                </div>
                <div className="mt-2">
                  <Pill tone={TYPE_TONES[env.connectionType]}>
                    <TypeIcon className="mr-1 h-3 w-3" aria-hidden />
                    {CONNECTION_TYPE_LABELS[env.connectionType]}
                  </Pill>
                </div>
                <ConnectionDetails env={env} />
                <CapabilityList capabilities={env.capabilities} />
                <div className="mt-3 flex items-center gap-2 text-xs">
                  <StatusBadge
                    status={env.connectionStatus}
                    label={env.connectionStatus === 'UNKNOWN' ? 'Not tested' : undefined}
                  />
                  {env.lastTestedAt && (
                    <span className="text-slate-400">{fmtRelative(env.lastTestedAt)}</span>
                  )}
                </div>
                {env.connectionMessage && (
                  <p
                    className={cx(
                      'mt-1.5 flex items-start gap-1 text-xs',
                      env.connectionStatus === 'FAILED' ? 'text-red-700' : 'text-slate-500',
                    )}
                  >
                    {env.connectionStatus === 'FAILED' ? (
                      <XCircle className="mt-0.5 h-3 w-3 flex-none" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-3 w-3 flex-none text-emerald-600" />
                    )}
                    {env.connectionMessage}
                  </p>
                )}
                <div className="mt-auto flex flex-wrap gap-2 pt-4">
                  <Button
                    size="sm"
                    icon={<PlugZap className="h-3.5 w-3.5" />}
                    loading={test.isPending && test.variables?.id === env.id}
                    onClick={() => test.mutate(env)}
                    disabled={!usable}
                  >
                    Test connection
                  </Button>
                  <Button
                    size="sm"
                    variant={isSource ? 'primary' : 'secondary'}
                    disabled={isSource || workspace.saving || !usable}
                    onClick={() => select('source', env)}
                  >
                    {isSource ? 'Source' : 'Set as source'}
                  </Button>
                  <Button
                    size="sm"
                    variant={isTarget ? 'primary' : 'secondary'}
                    disabled={isTarget || workspace.saving || !usable}
                    onClick={() => select('target', env)}
                  >
                    {isTarget ? 'Target' : 'Set as target'}
                  </Button>
                  {editable && (
                    <>
                      <Button
                        size="sm"
                        icon={<Pencil className="h-3.5 w-3.5" />}
                        onClick={() => {
                          setEditing(env);
                          setFormOpen(true);
                        }}
                        data-testid="edit-connection"
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        onClick={() => setDeleting(env)}
                        data-testid="delete-connection"
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {test.error && (
        <div className="mt-4">
          <ErrorState error={test.error} />
        </div>
      )}
      {list.length > 0 && !workspace.ready && (
        <div className="mt-6">
          <Callout tone="info" title="Choose a source and a target">
            A source and a target can be any two connections — Dataverse or SQL. The same connection cannot be
            both. Your selection is remembered for your next visit.
          </Callout>
        </div>
      )}
      {list.some((e) => e.connectionType !== 'DATAVERSE') && (
        <div className="mt-4">
          <Callout tone="info" title="SQL connections are opened directly">
            A SQL Server has to be reachable from wherever this application runs. A hosted deployment normally
            cannot reach a server behind a corporate firewall; the agent that would connect outward from your
            network is designed in docs/ON_PREM_AGENT_ARCHITECTURE.md and does not exist yet.
          </Callout>
        </div>
      )}

      {formOpen && (
        <ConnectionModal
          connection={editing}
          discovering={discover.isPending}
          onClose={() => setFormOpen(false)}
          onDiscover={() => discover.mutate()}
          onSaved={() => {
            setFormOpen(false);
            void qc.invalidateQueries({ queryKey: ['environments'] });
          }}
        />
      )}
      {deleting && (
        <DeleteConnectionModal
          connection={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void qc.invalidateQueries({ queryKey: ['environments'] });
            void qc.invalidateQueries({ queryKey: ['workspace'] });
          }}
        />
      )}
    </>
  );
}
