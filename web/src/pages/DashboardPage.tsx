import { PROJECT_KIND_LABELS, type DashboardDto } from '@shared/domain';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CalendarClock, FolderPlus, Microscope, Truck } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Pill,
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../components/ui';
import { get } from '../lib/api';
import { fmtNumber, fmtRelative } from '../lib/format';
import { useSession } from '../lib/session';

/**
 * The dashboard.
 *
 * Organized around work rather than around subsystems, because "what am I in the middle of" is the
 * question someone opening this actually has. Projects first, then what is running or about to run,
 * then history. The primary action is a new project, since that is now where everything starts.
 */
export function DashboardPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => get<DashboardDto>('/api/dashboard'),
    refetchInterval: 10_000,
  });

  const d = q.data;
  const nothingYet = d && d.projects.analysis + d.projects.migration === 0 && d.migrationRuns.total === 0;

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.displayName.split(' ')[0]}`}
        description="Analyse a source to understand it, or migrate data into a target. Work lives in projects."
        actions={
          <Button
            variant="primary"
            icon={<FolderPlus className="h-4 w-4" />}
            data-testid="dashboard-new-project"
            onClick={() => navigate('/projects?new=1')}
          >
            New project
          </Button>
        }
      />

      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      {d && nothingYet && (
        <EmptyState
          icon={<Microscope className="h-6 w-6" />}
          title="Nothing here yet"
          description={
            d.environments.total === 0
              ? 'Add a connection first, then create an analysis project to find out what is in the source.'
              : 'Create an analysis project to find out what is in a source, then a migration project that uses what it found.'
          }
          action={
            <Button
              variant="primary"
              onClick={() => navigate(d.environments.total === 0 ? '/environments' : '/projects?new=1')}
            >
              {d.environments.total === 0 ? 'Add a connection' : 'New project'}
            </Button>
          }
        />
      )}

      {d && !nothingYet && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
            <Stat
              label="Analysis projects"
              value={fmtNumber(d.projects.analysis)}
              tone="violet"
              hint={d.analyses.active > 0 ? `${d.analyses.active} running` : `${d.analyses.completed} run`}
              onClick={() => navigate('/projects')}
            />
            <Stat
              label="Migration projects"
              value={fmtNumber(d.projects.migration)}
              tone="blue"
              onClick={() => navigate('/projects')}
            />
            <Stat
              label="Findings"
              value={fmtNumber(d.analyses.blockers)}
              tone={d.analyses.blockers > 0 ? 'red' : 'green'}
              hint="blockers in the source"
            />
            <Stat
              label="Connections"
              value={fmtNumber(d.environments.total)}
              hint={`${d.environments.connected} connected`}
              onClick={() => navigate('/environments')}
            />
            <Stat
              label="Migrations"
              value={fmtNumber(d.migrationRuns.total)}
              hint={
                d.migrationRuns.active > 0
                  ? `${d.migrationRuns.active} active`
                  : `${d.migrationRuns.withErrors + d.migrationRuns.failed} with problems`
              }
              tone={d.migrationRuns.active > 0 ? 'amber' : 'default'}
              onClick={() => navigate('/runs')}
            />
            <Stat
              label="Schedules"
              value={fmtNumber(d.schedules.enabled)}
              tone={d.schedules.needsAttention > 0 ? 'red' : d.schedules.enabled > 0 ? 'green' : 'default'}
              hint={
                d.schedules.needsAttention > 0
                  ? `${d.schedules.needsAttention} need attention`
                  : `${d.schedules.total} in total`
              }
            />
          </div>

          {d.schedules.needsAttention > 0 && (
            <Card
              title="Schedules that need attention"
              subtitle="A schedule pauses itself rather than repeating the same failure. Open its plan to see why."
              actions={<AlertTriangle className="h-4 w-4 text-red-600" />}
            >
              <div className="space-y-2">
                {d.upcomingSchedules
                  .filter((s) => s.pausedReason || s.lastStatus === 'FAILED')
                  .map((s) => (
                    <div key={s.id} className="text-sm">
                      <Link
                        to={`/migration/plans/${s.planId}?step=review`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {s.planName}
                      </Link>{' '}
                      <span className="text-slate-500">— {s.name}.</span>{' '}
                      <span className="text-red-700">{s.pausedReason ?? s.lastError}</span>
                    </div>
                  ))}
                {d.upcomingSchedules.every((s) => !s.pausedReason && s.lastStatus !== 'FAILED') && (
                  <p className="text-sm text-slate-600">
                    Open the plan a schedule belongs to for the details.
                  </p>
                )}
              </div>
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card
              title="Projects"
              subtitle="Most recently worked on."
              data-testid="dashboard-projects"
              actions={
                <Link to="/projects" className="text-xs text-brand-700 hover:underline">
                  All projects
                </Link>
              }
            >
              {d.recentProjects.length === 0 ? (
                <p className="text-sm text-slate-500">No projects yet.</p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Name</Th>
                      <Th>Kind</Th>
                      <Th>Source</Th>
                      <Th>Updated</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.recentProjects.map((p) => (
                      <tr key={p.id} className="hover:bg-slate-50">
                        <Td>
                          <Link
                            to={`/projects/${p.id}`}
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {p.name}
                          </Link>
                        </Td>
                        <Td>
                          <Pill
                            tone={
                              p.kind === 'ANALYSIS' ? 'violet' : p.kind === 'COMPARISON' ? 'amber' : 'blue'
                            }
                          >
                            {PROJECT_KIND_LABELS[p.kind]}
                          </Pill>
                        </Td>
                        <Td className="text-xs text-slate-500">{p.sourceEnvironment?.displayName ?? '—'}</Td>
                        <Td className="text-xs text-slate-500">{fmtRelative(p.updatedAt)}</Td>
                        <Td>
                          <Link to={`/projects/${p.id}`} aria-label={`Open ${p.name}`}>
                            <ArrowRight className="h-4 w-4 text-slate-400" />
                          </Link>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <Card
              title="Recent analyses"
              subtitle="What the source actually contains, as last measured."
              actions={<Microscope className="h-4 w-4 text-violet-600" />}
            >
              {d.recentAnalyses.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No analyses yet. An analysis project reads a source and reports what is in it — read-only,
                  with no target involved.
                </p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Analysis</Th>
                      <Th>Status</Th>
                      <Th className="text-right">Tables</Th>
                      <Th className="text-right">Records</Th>
                      <Th>Statistics</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.recentAnalyses.map((a) => (
                      <tr key={a.id} className="hover:bg-slate-50">
                        <Td>
                          <Link
                            to={`/analyses/${a.id}`}
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {a.name}
                          </Link>
                        </Td>
                        <Td>
                          <StatusBadge status={a.status} />
                        </Td>
                        <Td className="text-right tabular-nums">{fmtNumber(a.totals.tables)}</Td>
                        <Td className="text-right tabular-nums">{fmtNumber(a.totals.records)}</Td>
                        <Td className="text-xs">
                          {a.basis ? (
                            <span className={a.basis === 'EXACT' ? 'text-emerald-700' : 'text-amber-700'}>
                              {a.basis === 'EXACT' ? 'exact' : 'sampled'}
                            </span>
                          ) : (
                            '—'
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>

          {d.upcomingSchedules.length > 0 && (
            <Card
              title="Running next"
              subtitle="Scheduled migrations, so what happens next is visible without asking."
              actions={<CalendarClock className="h-4 w-4 text-slate-500" />}
              data-testid="dashboard-schedules"
            >
              <Table>
                <thead>
                  <tr>
                    <Th>Plan</Th>
                    <Th>Schedule</Th>
                    <Th>Reads</Th>
                    <Th>Next run</Th>
                    <Th>Last run</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.upcomingSchedules.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <Td>
                        <Link
                          to={`/migration/plans/${s.planId}?step=review`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {s.planName}
                        </Link>
                      </Td>
                      <Td className="text-xs text-slate-600">
                        {s.description}
                        <span className="text-slate-400"> · {s.timeZone}</span>
                      </Td>
                      <Td className="text-xs">
                        {s.mode === 'INCREMENTAL' ? (
                          <Pill tone="violet">only what changed</Pill>
                        ) : (
                          <span className="text-slate-500">everything</span>
                        )}
                      </Td>
                      <Td className="text-xs text-slate-600">
                        {s.nextRunAt ? fmtRelative(s.nextRunAt) : '—'}
                      </Td>
                      <Td className="text-xs">
                        {s.lastStatus ? <StatusBadge status={s.lastStatus} /> : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

          {d.recentMigrationRuns.length > 0 && (
            <Card
              title="Recent migrations"
              subtitle="What was written, and what happened."
              actions={
                <Link to="/runs" className="text-xs text-brand-700 hover:underline">
                  All runs
                </Link>
              }
            >
              <Table>
                <thead>
                  <tr>
                    <Th>Plan</Th>
                    <Th>Status</Th>
                    <Th>Route</Th>
                    <Th className="text-right">Records</Th>
                    <Th className="text-right">Processed</Th>
                    <Th className="text-right">Failed</Th>
                    <Th>Started</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {d.recentMigrationRuns.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <Td className="font-medium">{r.planName}</Td>
                      <Td>
                        <StatusBadge status={r.status} />
                      </Td>
                      <Td className="text-xs text-slate-500">
                        {r.sourceEnvironment.displayName} → {r.targetEnvironment.displayName}
                      </Td>
                      <Td className="text-right tabular-nums">{fmtNumber(r.total)}</Td>
                      <Td className="text-right tabular-nums">{fmtNumber(r.processed)}</Td>
                      <Td className="text-right tabular-nums">
                        {r.failed > 0 ? <span className="text-red-700">{fmtNumber(r.failed)}</span> : '—'}
                      </Td>
                      <Td className="text-xs text-slate-500">{fmtRelative(r.createdAt)}</Td>
                      <Td>
                        <Link to={`/runs/${r.id}`} aria-label={`Open run of ${r.planName}`}>
                          <ArrowRight className="h-4 w-4 text-slate-400" />
                        </Link>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

          {d.projects.migration === 0 && d.projects.analysis > 0 && (
            <Card title="Next step">
              <p className="text-sm text-slate-600">
                You have analysed a source. Create a{' '}
                <Link to="/projects" className="text-brand-700 underline">
                  migration project
                </Link>{' '}
                based on that analysis, and its mapping workbook will already carry the record counts, empty
                columns and findings the analysis measured.
              </p>
              <div className="mt-3">
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Truck className="h-3.5 w-3.5" />}
                  onClick={() => navigate('/projects?new=1')}
                >
                  New migration project
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
