import type { AuditEventDto } from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Callout, Card, ErrorState, Modal, Mono, PageHeader, Pill, Spinner, StatusBadge, Table, Td, Th } from '../components/ui';
import { get, post } from '../lib/api';
import { fmtDate, humanize } from '../lib/format';
import { useSession } from '../lib/session';

interface SettingsDto {
  organization: { id: string; name: string; isDemo: boolean };
  demoMode: boolean;
  microsoft: { enabled: boolean; tenant: string; redirectUri: string; clientIdConfigured: boolean; discoveryUrl: string; powerPlatformEnrichment: boolean };
  safety: { businessLogicBypassAllowed: boolean; canBypass: boolean };
  database: string;
}

export function SettingsPage() {
  const { user } = useSession();
  const qc = useQueryClient();
  const [resetOpen, setResetOpen] = useState(false);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsDto>('/api/settings') });
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => get<AuditEventDto[]>('/api/audit?limit=200') });
  const reset = useMutation({
    mutationFn: () => post('/api/demo/reset'),
    onSuccess: () => {
      setResetOpen(false);
      void qc.invalidateQueries();
    },
  });

  return (
    <>
      <PageHeader title="Settings" description="Account, integration and safety configuration, plus the organization audit trail." />
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
              <Row label="Sign-in" value={user.authProvider === 'demo' ? 'Demo account' : 'Microsoft Entra ID'} />
            </dl>
          </Card>
          <Card title="Microsoft integration">
            <dl className="space-y-2 text-sm">
              <Row label="Status" value={<StatusBadge status={settings.data.microsoft.enabled ? 'CONNECTED' : 'UNKNOWN'} label={settings.data.microsoft.enabled ? 'Configured' : 'Not configured'} />} />
              <Row label="Tenant" value={<Mono>{settings.data.microsoft.tenant}</Mono>} />
              <Row label="Redirect URI" value={<Mono className="break-all">{settings.data.microsoft.redirectUri}</Mono>} />
              <Row label="Discovery" value={<Mono className="break-all">{settings.data.microsoft.discoveryUrl}</Mono>} />
              <Row label="Power Platform enrichment" value={settings.data.microsoft.powerPlatformEnrichment ? 'On' : 'Off'} />
            </dl>
            {!settings.data.microsoft.enabled && (
              <p className="mt-3 text-xs text-slate-500">Set ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET on the server. Secrets are never shown here.</p>
            )}
          </Card>
          <Card title="Safety">
            <dl className="space-y-2 text-sm">
              <Row label="Plug-in bypass" value={settings.data.safety.businessLogicBypassAllowed ? <Pill tone="amber">allowed for admins</Pill> : <Pill>disabled</Pill>} />
              <Row label="You can bypass" value={settings.data.safety.canBypass ? 'Yes (audited)' : 'No'} />
              <Row label="Default conflict strategy" value="Skip existing" />
              <Row label="Database" value={settings.data.database} />
            </dl>
            {settings.data.demoMode && settings.data.organization.isDemo && user.role === 'ADMIN' && (
              <div className="mt-4 border-t border-slate-100 pt-4">
                <Button variant="danger" size="sm" onClick={() => setResetOpen(true)}>
                  Reset demo environment data
                </Button>
                <p className="mt-1 text-xs text-slate-500">Restores the simulated Dataverse records. Run history is kept.</p>
              </div>
            )}
          </Card>
        </div>
      )}

      <Card title="Audit trail" subtitle="Sign-ins, environment connections, comparisons, plans, executions, cancellations, retries and validations." bodyClassName="p-0">
        {audit.isLoading && <Spinner />}
        {audit.error && <div className="p-4"><ErrorState error={audit.error} /></div>}
        {audit.data && (
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
              {audit.data.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-xs text-slate-500">{fmtDate(a.createdAt)}</Td>
                  <Td className="text-xs">{a.user ?? '—'}</Td>
                  <Td className="text-xs font-medium">{humanize(a.action)}</Td>
                  <Td><StatusBadge status={a.outcome === 'SUCCESS' ? 'PASS' : a.outcome === 'FAILURE' ? 'FAIL' : 'QUEUED'} label={a.outcome.toLowerCase()} /></Td>
                  <Td className="text-xs">{a.sourceEnvironment ?? '—'}</Td>
                  <Td className="text-xs">{a.targetEnvironment ?? '—'}</Td>
                  <Td><Mono className="text-[11px]">{a.runId ? a.runId.slice(0, 8) : '—'}</Mono></Td>
                  <Td className="max-w-xs truncate text-[11px] text-slate-500" >{a.details ? JSON.stringify(a.details) : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

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
        <Callout tone="warning">This affects only the simulated DEMO environments stored by this application.</Callout>
        {reset.error && <div className="mt-3"><ErrorState error={reset.error} /></div>}
      </Modal>
    </>
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
