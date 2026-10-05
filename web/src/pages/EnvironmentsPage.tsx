import { levelRank, summaryLevel, VERIFICATION_LABELS } from '@shared/connector-verification';
import type {
  ConnectionTestResultDto,
  ConnectionType,
  ConnectorCapabilities,
  EnvironmentDto,
} from '@shared/domain';
import { CONNECTION_TYPE_LABELS, isSqlConnection, isStagedConnection } from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Cloud,
  Database,
  FileSpreadsheet,
  FolderOpen,
  Globe,
  List,
  MapPin,
  Minus,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Server,
  Table2,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ConnectionModal } from '../components/ConnectionForm';
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
} from '../components/ui';
import { api, get, post } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { useSession } from '../lib/session';

const TYPE_ICONS: Record<ConnectionType, typeof Database> = {
  DATAVERSE: Database,
  SQL_SERVER: Server,
  AZURE_SQL: Cloud,
  POSTGRES: Server,
  MYSQL: Server,
  FILE: FileSpreadsheet,
  ONEDRIVE: FolderOpen,
  SHAREPOINT: List,
};

const TYPE_TONES: Record<ConnectionType, 'violet' | 'blue' | 'teal' | 'slate' | 'amber'> = {
  DATAVERSE: 'violet',
  SQL_SERVER: 'blue',
  AZURE_SQL: 'teal',
  POSTGRES: 'slate',
  MYSQL: 'slate',
  FILE: 'amber',
  ONEDRIVE: 'amber',
  SHAREPOINT: 'amber',
};

/** Capabilities shown on every card. Read from the connector, never inferred from the provider. */
const CAPABILITIES: [keyof ConnectorCapabilities, string, string][] = [
  ['supportsRead', 'Read', 'Reads tables and records'],
  ['supportsWrite', 'Write', 'Can be used as a migration target'],
  ['supportsTransactions', 'Transactions', 'Groups writes so a failed batch can be rolled back'],
  ['supportsOwnership', 'Ownership', 'Records have an owner the migration can set'],
  ['supportsAuditImpersonation', 'Audit attribution', 'Created by / modified by can be preserved'],
];

/**
 * What we have actually seen this connector do, beside what it is allowed to do.
 *
 * The pills above answer "may the planner use this?". This answers "have we run it, and against
 * what?" — which is the question somebody about to move their data is really asking. A capability
 * flag set to true is a statement about code; a verification level is a statement about evidence,
 * and the card says both because they are not the same thing.
 *
 * The headline is the connector's *weakest* meaningful capability, never its best. A connector with
 * nine verified capabilities and one simulated one has a simulated capability in it, and somebody
 * glancing at a single badge must not be told otherwise.
 */
function VerificationNote({ type }: { type: ConnectionType }) {
  const level = summaryLevel(type);
  if (!level) return null;
  const meta = VERIFICATION_LABELS[level];
  const strong = levelRank(level) >= levelRank('ENGINE_VERIFIED');
  const absent = level === 'NOT_SUPPORTED';
  return (
    <div className="mt-2 text-xs text-slate-500">
      <Pill tone={strong ? 'teal' : absent ? 'slate' : 'amber'}>{meta.label}</Pill>{' '}
      <span>{meta.meaning}</span>
      <p className="mt-1 text-[11px] text-slate-400">{meta.evidence}</p>
    </div>
  );
}

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

/**
 * What a connection's state actually is, in words that mean something.
 *
 * The old card said "Connected" for anything whose row said so — including a simulated demo environment
 * that nothing had ever contacted, and a database nobody had tested since it was typed in. "Connected"
 * that only means "a row exists" is worse than no badge at all, because it is the one piece of the screen
 * somebody checks before trusting the rest.
 *
 * Four states, and no more. `Authentication expired` and `Unavailable` are not here because nothing in the
 * platform can currently establish either: a 401 from a database is indistinguishable here from a wrong
 * password, and inventing the distinction would be the same mistake in a new place.
 */
type ConnectionState = {
  label: string;
  tone: 'teal' | 'amber' | 'slate' | 'blue';
  /** What it means, for somebody deciding whether to rely on it. */
  detail: string;
};

function connectionState(env: EnvironmentDto): ConnectionState {
  /*
   * A failure outranks being simulated. The demo tenant deliberately refuses one environment to show what
   * that looks like, and reporting it as "Simulated" would bury the one message on the card worth reading.
   */
  if (env.connectionStatus === 'FAILED') {
    return {
      label: 'Needs attention',
      tone: 'amber',
      detail: env.connectionMessage ?? 'The last attempt to reach it did not succeed.',
    };
  }
  /*
   * A real test result outranks everything, including being simulated — the card carries a DEMO pill for
   * that, and the question this badge answers is "has anything actually reached it", which a test answers
   * and a row in a table does not.
   */
  if (env.connectionStatus === 'CONNECTED' && env.lastTestedAt) {
    return {
      label: 'Connected',
      tone: 'teal',
      detail: env.connectionMessage ?? 'Reached successfully when it was last tested.',
    };
  }
  /*
   * Untested and simulated. Said as "Simulated" rather than "Not tested" because the more useful fact
   * about it is that there is nothing real on the other side to test.
   */
  if (env.provider === 'demo' || env.provider === 'demosql') {
    return {
      label: 'Simulated',
      tone: 'blue',
      detail: 'A demonstration connection. Nothing real is contacted and no real data is read.',
    };
  }
  return {
    label: 'Not tested',
    tone: 'slate',
    detail: 'Nothing has tried to reach it yet, so whether it works is unknown.',
  };
}

/**
 * What is inside a connection, read-only.
 *
 * The question the Connections page exists to answer is "what can this organization reach", and a list of
 * names answers half of it. This answers the other half without anybody having to create a project to
 * find out. Nothing here selects anything: choosing data is a thing you do inside the work that needs it.
 */
function BrowseConnectionModal({ connection, onClose }: { connection: EnvironmentDto; onClose: () => void }) {
  const staged = isStagedConnection(connection.connectionType);
  const tables = useQuery({
    queryKey: staged ? ['staged-tables', connection.id] : ['environment-tables', connection.id],
    queryFn: () =>
      staged
        ? get<{ logicalName: string; displayName: string; rowCount: number; columnCount: number }[]>(
            `/api/staged-sources/${connection.id}/tables`,
          ).then((rows) =>
            rows.map((r) => ({
              logicalName: r.logicalName,
              displayName: r.displayName,
              detail: `${r.rowCount.toLocaleString()} rows · ${r.columnCount} columns`,
            })),
          )
        : get<{ logicalName: string; displayName: string; sqlSchema?: string | null; isView?: boolean }[]>(
            `/api/environments/${connection.id}/tables`,
          ).then((rows) =>
            rows.map((r) => ({
              logicalName: r.logicalName,
              displayName: r.displayName,
              detail: r.isView ? 'View' : (r.sqlSchema ?? ''),
            })),
          ),
  });

  return (
    <Modal open onClose={onClose} wide title={connection.displayName}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          What this connection can reach. To work with any of it, add it as a dataset inside a project.
        </p>
        {tables.isLoading && <Spinner label="Reading what is in it…" />}
        {tables.error && <ErrorState error={tables.error} />}
        {tables.data && tables.data.length === 0 && (
          <EmptyState
            title="Nothing in it yet"
            description={
              staged
                ? 'Nothing has been selected from this connection. It holds access, not data.'
                : 'No tables were returned.'
            }
          />
        )}
        {tables.data && tables.data.length > 0 && (
          <>
            <p className="text-xs text-slate-500">{tables.data.length} objects</p>
            <ul
              className="max-h-80 divide-y divide-slate-100 overflow-auto rounded-md border border-slate-200"
              data-testid="connection-contents"
            >
              {tables.data.map((table) => (
                <li key={table.logicalName} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-900">{table.logicalName}</span>
                  <span className="flex-none text-xs text-slate-500">{table.detail}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

export function EnvironmentsPage() {
  const qc = useQueryClient();
  const { user } = useSession();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [kindFilter, setKindFilter] = useState('ALL');
  const [editing, setEditing] = useState<EnvironmentDto | null>(null);
  /**
   * `?new=1` opens the form on arrival, so "add a connection" from somewhere else lands on the form
   * rather than on the list with the button still to find. A URL rather than router state, because
   * it survives a reload and can be linked to.
   */
  const [params, setParams] = useSearchParams();
  const [formOpen, setFormOpen] = useState(params.get('new') === '1');
  /** Closing also drops `?new=1`, so a reload does not reopen the form. */
  const closeForm = () => {
    setFormOpen(false);
    if (params.get('new')) {
      const next = new URLSearchParams(params);
      next.delete('new');
      setParams(next, { replace: true });
    }
  };
  const [deleting, setDeleting] = useState<EnvironmentDto | null>(null);
  /**
   * The file source just created, so the page can take you to its import control.
   *
   * Creating one used to close the dialog and leave you at the top of the connections page, with
   * the file picker in a section below every other connection. The source existed and there was
   * nothing on screen to suggest what to do next.
   */
  /** The connection just saved, so the next thing on screen is its data rather than a congratulation. */
  const [browsing, setBrowsing] = useState<EnvironmentDto | null>(null);

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
      /*
       * An uploaded spreadsheet is not a connection. It is reusable access to nothing — there is no host,
       * no credential and no system on the other side — and listing it here was the implementation's
       * vocabulary leaking into the product. SharePoint and OneDrive do belong: those authenticate.
       * A file is managed where it is used, in the project's datasets.
       */
      e.connectionType !== 'FILE' &&
      (typeFilter === 'ALL' || e.environmentType === typeFilter) &&
      (kindFilter === 'ALL' || e.connectionType === kindFilter) &&
      `${e.displayName} ${e.url} ${e.uniqueName ?? ''} ${e.sql?.database ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  return (
    <>
      {/*
        No step indicator here. Connections is a platform area — somebody adding a database or
        rotating a credential is not at step 1 of 9 of a migration, and saying they are made every
        workspace-level task look like part of a flow they had not started. The guided path into
        the flow is the "Continue to Analyze" action below, which appears once a source and target
        are chosen.
      */}
      <PageHeader
        title="Connections"
        /*
         * What this page is for, said in one line. It answers "what systems can this organization reach",
         * and nothing else: it is not a step of a migration, and nothing here is a source or a target.
         * Which data a piece of work uses is decided inside that work.
         */
        description={
          user.organization.isDemo
            ? 'Systems this demo workspace can reach. Simulated — nothing real is contacted.'
            : 'Systems and storage locations available to your organization. Add one here, then use it in any project.'
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

      {discover.error && (
        <div className="mb-4">
          <ErrorState error={discover.error} onRetry={() => discover.mutate()} />
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
          // Dataverse without the Dataverse API is unusable; a SQL connection always is.
          const usable = env.connectionType !== 'DATAVERSE' || env.dataverseAvailable;
          const staged = isStagedConnection(env.connectionType);
          // An upload has nothing to reach; OneDrive and SharePoint do, so those keep the test that
          // tells someone which of consent, scope or reachability is the problem.
          const testable = !staged || env.connectionType !== 'FILE';
          // A staged source has no settings to edit — it has data to import, which is its own card.
          const editable = env.connectionType !== 'DATAVERSE' && !staged;
          const TypeIcon = TYPE_ICONS[env.connectionType];
          const state = connectionState(env);
          return (
            <article
              key={env.id}
              data-testid={`connection-card-${env.displayName}`}
              className="flex flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
            >
              {/* Inner wrapper keeps the original env-card test hook while the card gains its own. */}
              <div data-testid={`env-card-${env.displayName}`} className="flex flex-1 flex-col">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-slate-900">{env.displayName}</h3>
                    <p className="truncate font-mono text-xs text-slate-500">{env.url}</p>
                  </div>
                  <div className="flex flex-none flex-col items-end gap-1">
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
                <VerificationNote type={env.connectionType} />
                <div className="mt-3 flex items-center gap-2 text-xs">
                  <Pill tone={state.tone}>{state.label}</Pill>
                  <span className="text-slate-400">
                    {env.lastTestedAt ? `Last tested ${fmtRelative(env.lastTestedAt)}` : 'Never tested'}
                  </span>
                </div>
                <p className="mt-1.5 text-xs text-slate-500">{state.detail}</p>
                <div className="mt-auto flex flex-wrap gap-2 pt-4">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Table2 className="h-3.5 w-3.5" />}
                    onClick={() => setBrowsing(env)}
                    data-testid="browse-connection"
                  >
                    Browse data
                  </Button>
                  {testable && (
                    <Button
                      size="sm"
                      icon={<PlugZap className="h-3.5 w-3.5" />}
                      loading={test.isPending && test.variables?.id === env.id}
                      onClick={() => test.mutate(env)}
                      disabled={!usable}
                    >
                      Test connection
                    </Button>
                  )}
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
      {list.some((e) => isSqlConnection(e.connectionType)) && (
        <div className="mt-4">
          <Callout tone="info" title="Database connections are opened directly">
            A database server has to be reachable from wherever this application runs. A hosted deployment
            normally cannot reach a server behind a corporate firewall; the agent that would connect outward
            from your network is designed in docs/ON_PREM_AGENT_ARCHITECTURE.md and does not exist yet. A file
            source needs none of this — its data is uploaded rather than fetched.
          </Callout>
        </div>
      )}

      {formOpen && (
        <ConnectionModal
          connection={editing}
          discovering={discover.isPending}
          onClose={closeForm}
          onDiscover={() => discover.mutate()}
          onSaved={(saved) => {
            closeForm();
            void qc.invalidateQueries({ queryKey: ['environments'] });
            /*
             * Straight to the data. Storing a credential is infrastructure, not an achievement, and a
             * dialog that closed on a saved connection left somebody looking at a list wondering what they
             * had actually gained. The useful next thing is what the connection can now reach.
             */
            setBrowsing(saved);
          }}
        />
      )}
      {browsing && <BrowseConnectionModal connection={browsing} onClose={() => setBrowsing(null)} />}
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
