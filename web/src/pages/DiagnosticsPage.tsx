import type { DiagnosticCheckDto, DiagnosticsReportDto, DiagnosticStatus } from '@shared/domain';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleDashed, Play, XCircle } from 'lucide-react';
import { Button, Callout, Card, ErrorState, PageHeader, Spinner } from '../components/ui';
import { post } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useSession, useWorkspace } from '../lib/session';

const ICONS: Record<DiagnosticStatus, { Icon: typeof CheckCircle2; cls: string; label: string }> = {
  PASS: { Icon: CheckCircle2, cls: 'text-emerald-600', label: 'Pass' },
  WARN: { Icon: AlertTriangle, cls: 'text-amber-600', label: 'Warning' },
  FAIL: { Icon: XCircle, cls: 'text-red-600', label: 'Fail' },
  NOT_TESTED: { Icon: CircleDashed, cls: 'text-slate-400', label: 'Not tested' },
};

function CheckRow({ check }: { check: DiagnosticCheckDto }) {
  const { Icon, cls, label } = ICONS[check.status];
  return (
    <li className="flex gap-3 px-4 py-3" data-testid={`diagnostic-${check.key}`}>
      <Icon className={`mt-0.5 h-4.5 w-4.5 flex-none ${cls}`} aria-label={label} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">
          {check.label}
          {check.durationMs !== undefined && (
            <span className="ml-2 text-xs font-normal text-slate-400">{check.durationMs} ms</span>
          )}
        </p>
        <p className="mt-0.5 break-words text-sm text-slate-600">{check.message}</p>
        {check.resolution && <p className="mt-1 text-xs text-slate-500">{check.resolution}</p>}
      </div>
    </li>
  );
}

export function DiagnosticsPage() {
  const { user, realTenantReadOnly } = useSession();
  const { source, target, isLoading } = useWorkspace();
  const run = useMutation({
    mutationFn: () =>
      post<DiagnosticsReportDto>('/api/diagnostics', {
        sourceEnvironmentId: source?.id,
        targetEnvironmentId: target?.id,
      }),
  });
  const report = run.data;

  return (
    <>
      <PageHeader
        title="Diagnostics"
        description="Read-only checks of the Microsoft connection. Nothing here writes to Dataverse; write permission is never probed."
        actions={
          <Button
            variant="primary"
            icon={<Play className="h-4 w-4" />}
            loading={run.isPending}
            onClick={() => run.mutate()}
            data-testid="run-diagnostics"
          >
            Run diagnostics
          </Button>
        }
      />

      {realTenantReadOnly && !user.organization.isDemo && (
        <div className="mb-4">
          <Callout tone="info" title="REAL TENANT — READ ONLY">
            This deployment blocks every Dataverse write in the server. Diagnostics, discovery, comparison,
            validation and preflight all work; migrations cannot be started.
          </Callout>
        </div>
      )}
      {user.organization.isDemo && (
        <div className="mb-4">
          <Callout tone="warning" title="Demo organization">
            These checks run against simulated environments. They prove the application works end to end, not
            that a Microsoft tenant is reachable.
          </Callout>
        </div>
      )}

      {!isLoading && (!source || !target) && (
        <div className="mb-4">
          <Callout tone="warning" title="Select environments for the full set of checks">
            Metadata, record read, user discovery and impersonation checks need a source and a target
            environment selected in the workspace.
          </Callout>
        </div>
      )}

      {run.isPending && <Spinner label="Running read-only checks…" />}
      {run.error && <ErrorState error={run.error} onRetry={() => run.mutate()} />}

      {report && (
        <Card
          title="Results"
          actions={
            <span className="text-xs text-slate-500">
              {fmtDate(report.ranAt)}
              {report.sourceEnvironment && ` · source ${report.sourceEnvironment.displayName}`}
              {report.targetEnvironment && ` · target ${report.targetEnvironment.displayName}`}
            </span>
          }
          bodyClassName="p-0"
        >
          <ul className="divide-y divide-slate-100">
            {report.checks.map((c) => (
              <CheckRow key={c.key} check={c} />
            ))}
          </ul>
        </Card>
      )}

      {!report && !run.isPending && (
        <Card>
          <p className="text-sm text-slate-600">
            Run diagnostics to check authentication, token acquisition, environment discovery, both
            connections, metadata access, record read permission, user discovery and the impersonation
            privilege. Tokens are never displayed and raw responses are never dumped.
          </p>
        </Card>
      )}
    </>
  );
}
