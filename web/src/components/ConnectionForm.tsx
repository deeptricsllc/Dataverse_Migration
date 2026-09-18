import type {
  ConnectionCheckDto,
  ConnectionTestResultDto,
  ConnectionType,
  EnvironmentDto,
  SqlAuthType,
} from '@shared/domain';
import { CONNECTION_TYPE_LABELS, SQL_AUTH_IMPLEMENTED } from '@shared/domain';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleDashed, PlugZap, RefreshCw, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { patch, post } from '../lib/api';
import { Button, Callout, ErrorState, Modal } from './ui';

type SqlType = Exclude<ConnectionType, 'DATAVERSE'>;

const TYPE_HINTS: Record<ConnectionType, string> = {
  DATAVERSE: 'Discovered from your Microsoft account.',
  SQL_SERVER: 'On-premises or self-hosted SQL Server.',
  AZURE_SQL: 'Azure SQL Database or Managed Instance.',
};

const AUTH_LABELS: Record<SqlAuthType, string> = {
  SQL_LOGIN: 'SQL authentication (login and password)',
  ENTRA_PASSWORD: 'Microsoft Entra password',
  ENTRA_INTEGRATED: 'Microsoft Entra integrated',
  MANAGED_IDENTITY: 'Managed identity',
  WINDOWS: 'Windows authentication',
};

const CHECK_ICONS: Record<
  ConnectionCheckDto['status'],
  { Icon: typeof CheckCircle2; cls: string; label: string }
> = {
  PASS: { Icon: CheckCircle2, cls: 'text-emerald-600', label: 'Pass' },
  WARN: { Icon: AlertTriangle, cls: 'text-amber-600', label: 'Warning' },
  FAIL: { Icon: XCircle, cls: 'text-red-600', label: 'Fail' },
  NOT_TESTED: { Icon: CircleDashed, cls: 'text-slate-400', label: 'Not tested' },
};

const INPUT =
  'mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

interface SqlForm {
  displayName: string;
  host: string;
  port: string;
  database: string;
  authType: SqlAuthType;
  username: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  schemas: string;
}

const BLANK: SqlForm = {
  displayName: '',
  host: '',
  port: '1433',
  database: '',
  authType: 'SQL_LOGIN',
  username: '',
  password: '',
  encrypt: true,
  trustServerCertificate: false,
  schemas: '',
};

/** Pre-fills from a stored connection. The password is never returned by the API, so it stays blank. */
function formFor(connection: EnvironmentDto | null): SqlForm {
  const sql = connection?.sql;
  if (!connection || !sql) return BLANK;
  return {
    displayName: connection.displayName,
    host: sql.host,
    port: String(sql.port),
    database: sql.database,
    authType: sql.authType,
    username: sql.username ?? '',
    password: '',
    encrypt: sql.encrypt,
    trustServerCertificate: sql.trustServerCertificate,
    schemas: sql.schemas.join(', '),
  };
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-600">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function TestResult({ result }: { result: ConnectionTestResultDto }) {
  return (
    <div className="rounded-md border border-slate-200">
      <p
        className={`border-b border-slate-100 px-3 py-2 text-sm font-medium ${
          result.ok ? 'text-emerald-700' : 'text-red-700'
        }`}
      >
        {result.summary}
      </p>
      <ul className="divide-y divide-slate-100">
        {result.checks.map((c) => {
          const { Icon, cls, label } = CHECK_ICONS[c.status];
          return (
            <li key={c.key} className="flex gap-2.5 px-3 py-2">
              <Icon className={`mt-0.5 h-4 w-4 flex-none ${cls}`} aria-label={label} />
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-900">{c.label}</p>
                <p className="mt-0.5 break-words text-xs text-slate-600">{c.message}</p>
                {c.resolution && <p className="mt-0.5 text-xs text-slate-500">{c.resolution}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Adds or edits a connection. Dataverse environments have no form: they come from discovery,
 * so choosing that type explains where they come from and offers the discovery action instead.
 */
export function ConnectionModal({
  connection,
  onClose,
  onSaved,
  onDiscover,
  discovering,
}: {
  connection: EnvironmentDto | null;
  onClose: () => void;
  onSaved: (connection: EnvironmentDto) => void;
  onDiscover: () => void;
  discovering: boolean;
}) {
  const [type, setType] = useState<ConnectionType | null>(connection?.connectionType ?? null);
  const [form, setForm] = useState<SqlForm>(() => formFor(connection));
  const [result, setResult] = useState<ConnectionTestResultDto | null>(null);
  const update = (values: Partial<SqlForm>) => setForm((f) => ({ ...f, ...values }));

  const body = () => ({
    displayName: form.displayName.trim() || `${form.host.trim()}/${form.database.trim()}`,
    connectionType: type as SqlType,
    host: form.host.trim(),
    port: Number(form.port) || 1433,
    database: form.database.trim(),
    authType: form.authType,
    username: form.username.trim() || null,
    // Omitted rather than emptied: an empty password means "keep the stored one".
    ...(form.password ? { password: form.password } : {}),
    encrypt: form.encrypt,
    trustServerCertificate: form.trustServerCertificate,
    schemas: form.schemas
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    transport: 'DIRECT' as const,
  });

  const test = useMutation({
    mutationFn: () => post<ConnectionTestResultDto>('/api/connections/test', body()),
    onSuccess: setResult,
  });
  const save = useMutation({
    mutationFn: () =>
      connection
        ? patch<EnvironmentDto>(`/api/connections/${connection.id}`, body())
        : post<EnvironmentDto>('/api/connections', body()),
    onSuccess: onSaved,
  });

  const isSql = type === 'SQL_SERVER' || type === 'AZURE_SQL';
  const isAzure = type === 'AZURE_SQL';
  const complete =
    Boolean(form.host.trim()) &&
    Boolean(form.database.trim()) &&
    (form.authType !== 'SQL_LOGIN' || Boolean(form.username.trim()));

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={connection ? `Edit ${connection.displayName}` : 'Add connection'}
      footer={
        isSql ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              icon={<PlugZap className="h-4 w-4" />}
              loading={test.isPending}
              disabled={!complete}
              onClick={() => test.mutate()}
              data-testid="test-connection"
            >
              Test connection
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!complete}
              onClick={() => save.mutate()}
              data-testid="save-connection"
            >
              {result && !result.ok
                ? 'Save anyway (test failed)'
                : connection
                  ? 'Save changes'
                  : 'Save connection'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <div className="space-y-4">
        {!connection && (
          <fieldset>
            <legend className="text-xs font-medium text-slate-600">What are you connecting to?</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {(['DATAVERSE', 'SQL_SERVER', 'AZURE_SQL'] as ConnectionType[]).map((t) => (
                <label
                  key={t}
                  data-testid={`connection-type-${t}`}
                  className="flex cursor-pointer gap-2 rounded-md border border-slate-200 p-2 text-sm has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50"
                >
                  <input
                    type="radio"
                    name="connection-type"
                    value={t}
                    checked={type === t}
                    onChange={() => {
                      setType(t);
                      setResult(null);
                    }}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{CONNECTION_TYPE_LABELS[t]}</span>
                    <span className="block text-xs text-slate-500">{TYPE_HINTS[t]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {type === null && <p className="text-sm text-slate-500">Choose a connection type to continue.</p>}

        {type === 'DATAVERSE' && (
          <>
            <Callout tone="info" title="Dataverse environments are discovered, not typed in">
              Discovery asks the Microsoft Global Discovery Service which environments your account can reach
              and lists them here. An environment that does not appear is one your account has no access to —
              there is nothing to configure by hand.
            </Callout>
            <Button
              icon={<RefreshCw className="h-4 w-4" />}
              loading={discovering}
              onClick={onDiscover}
              data-testid="discover-dataverse"
            >
              Discover Dataverse environments
            </Button>
          </>
        )}

        {isSql && (
          <form
            data-testid="connection-form"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (complete) save.mutate();
            }}
          >
            <Field id="conn-name" label="Connection name" hint="Shown everywhere this connection is used.">
              <input
                id="conn-name"
                value={form.displayName}
                onChange={(e) => update({ displayName: e.target.value })}
                placeholder={isAzure ? 'Azure SQL — sales' : 'Legacy SQL Server'}
                maxLength={200}
                className={INPUT}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
              <Field
                id="conn-host"
                label="Server / host"
                hint={isAzure ? 'For example yourserver.database.windows.net' : 'Host name or IP address.'}
              >
                <input
                  id="conn-host"
                  value={form.host}
                  onChange={(e) => update({ host: e.target.value })}
                  placeholder={isAzure ? 'yourserver.database.windows.net' : 'sql01.corp.local'}
                  autoComplete="off"
                  className={INPUT}
                />
              </Field>
              <Field id="conn-port" label="Port">
                <input
                  id="conn-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={form.port}
                  onChange={(e) => update({ port: e.target.value })}
                  className={INPUT}
                />
              </Field>
            </div>

            <Field id="conn-database" label="Database">
              <input
                id="conn-database"
                value={form.database}
                onChange={(e) => update({ database: e.target.value })}
                autoComplete="off"
                className={INPUT}
              />
            </Field>

            <Field
              id="conn-auth"
              label="Authentication"
              hint="Only SQL authentication is implemented. The other modes are listed so you can see they are planned, not available."
            >
              <select
                id="conn-auth"
                value={form.authType}
                onChange={(e) => update({ authType: e.target.value as SqlAuthType })}
                className={INPUT}
              >
                {(Object.keys(AUTH_LABELS) as SqlAuthType[]).map((a) => (
                  <option key={a} value={a} disabled={!SQL_AUTH_IMPLEMENTED.has(a)}>
                    {AUTH_LABELS[a]}
                    {SQL_AUTH_IMPLEMENTED.has(a) ? '' : ' — not implemented yet'}
                  </option>
                ))}
              </select>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="conn-username" label="Username">
                <input
                  id="conn-username"
                  value={form.username}
                  onChange={(e) => update({ username: e.target.value })}
                  autoComplete="off"
                  className={INPUT}
                />
              </Field>
              <Field
                id="conn-password"
                label="Password"
                hint={
                  connection
                    ? 'Leave blank to keep the stored password.'
                    : 'Encrypted before it is stored and never sent back to the browser.'
                }
              >
                <input
                  id="conn-password"
                  type="password"
                  value={form.password}
                  onChange={(e) => update({ password: e.target.value })}
                  autoComplete="new-password"
                  className={INPUT}
                />
              </Field>
            </div>

            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.encrypt}
                  onChange={(e) => update({ encrypt: e.target.checked })}
                />
                Encrypt connection
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.trustServerCertificate}
                  onChange={(e) => update({ trustServerCertificate: e.target.checked })}
                />
                Trust server certificate
              </label>
              <p className="text-xs text-slate-500">
                Trusting the certificate disables certificate validation, so the connection can no longer
                prove it reached the right server. Use it only for a self-signed certificate on a server
                inside your own network.
              </p>
            </div>

            <Field
              id="conn-schemas"
              label="Schemas (optional)"
              hint="Comma-separated, for example dbo, sales. Leave empty to include every schema the login can read."
            >
              <input
                id="conn-schemas"
                value={form.schemas}
                onChange={(e) => update({ schemas: e.target.value })}
                placeholder="dbo, sales"
                className={INPUT}
              />
            </Field>

            <Callout tone="info" title="The server has to be reachable from where this application runs">
              This connection is opened directly by the application. A hosted deployment normally cannot reach
              a SQL Server that sits behind a corporate firewall; Azure SQL works if its firewall allows the
              application&apos;s addresses. An agent that runs inside your network and connects outward is
              designed in docs/ON_PREM_AGENT_ARCHITECTURE.md and does not exist yet.
            </Callout>

            {test.error && <ErrorState error={test.error} />}
            {result && <TestResult result={result} />}
            {save.error && <ErrorState error={save.error} />}
          </form>
        )}
      </div>
    </Modal>
  );
}
