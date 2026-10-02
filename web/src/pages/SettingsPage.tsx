import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Callout,
  Card,
  ErrorState,
  Modal,
  Mono,
  PageHeader,
  Pill,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { AccessRequestsCard } from '../components/AccessRequestsCard';
import { get, post } from '../lib/api';
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
  build: { version: string; commit: string | null; branch: string | null; deployment: string };
}

export function SettingsPage() {
  const { user } = useSession();
  const qc = useQueryClient();
  const [resetOpen, setResetOpen] = useState(false);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsDto>('/api/settings') });
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
                Microsoft sign-in isn’t enabled for this environment. Contact your DeepTrics contact to
                connect your tenant. Credentials are held on the server and are never shown here or sent to
                the browser.
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
              {/*
                Which build produced what you are looking at. The first thing anyone needs when a report
                is disputed, and the thing nobody can supply from memory.
              */}
              <Row
                label="Build"
                value={
                  <span className="font-mono text-xs">
                    v{settings.data.build.version} · {settings.data.build.deployment}
                    {settings.data.build.commit ? ` · ${settings.data.build.commit}` : ''}
                  </span>
                }
              />
            </dl>
            {settings.data.demoMode && settings.data.organization.isDemo && user.role === 'ADMIN' && (
              <div className="mt-4 border-t border-slate-100 pt-4">
                <Button variant="danger" size="sm" onClick={() => setResetOpen(true)}>
                  Reset the demo workspace
                </Button>
                <p className="mt-1 text-xs text-slate-500">
                  Restores the simulated records, archives the projects in this workspace and migrates the two
                  worked examples again against the restored data. Nothing is deleted and run history is kept.
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

      {/*
        The audit trail has its own destination now. It lived here, which is where a feature goes when
        nobody has decided what it is — an audit trail is not a setting, it is the record somebody consults
        when they are asked what happened. Left as a pointer rather than a second copy of the same view.
      */}
      <Card className="p-6">
        <h2 className="text-sm font-semibold text-slate-900">Audit trail</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Every consequential action in this workspace, filterable by what happened, who did it and when.
        </p>
        <Link
          to="/audit"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline"
        >
          Open the audit trail
        </Link>
      </Card>

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset the demo workspace?"
        footer={
          <>
            <Button onClick={() => setResetOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate()}>
              Reset the workspace
            </Button>
          </>
        }
      >
        <Callout tone="warning">
          This affects only the simulated DEMO environments stored by this application. Everyone evaluating
          the product shares this workspace, so every project in it is archived and the two worked examples
          are migrated again from scratch — restoring the records is what makes that necessary, since the old
          runs describe data that is no longer there. Archived projects stay readable behind “Show archived”
          on the projects page, and the rebuild takes a few seconds.
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

/**
 * What an audit event recorded, as a sentence, with the evidence a click away.
 *
 * The column used to be `JSON.stringify(details)` truncated mid-token, so the audit trail — the
 * feature a regulated customer looks at hardest — read like a log file somebody forgot to format.
 * Nothing is hidden: the structured record is still there under "details", which is the half an
 * engineer wants during an incident. The summary is the half everybody else wants.
 */

/**
 * A short phrase for the values an event carried.
 *
 * Deliberately generic: audit details are an open bag whose shape differs per action, and a
 * hand-written sentence per action would drift out of step with what the server records. Naming
 * the fields and showing the small ones is honest about that without pretending to more.
 */

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

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-800">{value}</dd>
    </div>
  );
}
