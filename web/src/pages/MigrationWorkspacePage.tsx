import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Database, Layers, Server } from 'lucide-react';
import type {
  MigrationPlanDto,
  MigrationProjectStatus,
  MigrationWorkspaceDto,
  ProjectDto,
  MigrationRunStatus,
} from '@shared/domain';
import { MIGRATION_PROJECT_STATUS_LABELS } from '@shared/domain';
import type { ReadinessFinding } from '@shared/readiness';
import { Button, Card, EmptyState, ErrorState, PageHeader, Pill, Spinner, Tabs, cx } from '../components/ui';
import { ExecuteModal } from './PlanPage';
import { MigrationData } from '../components/MigrationData';
import {
  MigrationDependencies,
  MigrationMapping,
  MigrationRuns,
  MigrationTransformations,
} from '../components/MigrationSections';
import { api } from '../lib/api';
import { describeCount } from '../lib/format';

/**
 * A migration project: one workspace, not nine pages.
 *
 * The product this replaces answered "are we ready" with "I completed step 6", because readiness lived
 * on a page you reached by clicking Continue four times and could not return to without starting again.
 * Every section here is always available, in any order, as many times as the work needs — which is what a
 * migration actually is: scope changes, mappings get revisited, a run fails and you come back.
 *
 * Nothing here recomputes anything. The verdict, the blockers, the dependency order and the run metrics
 * are all produced by services that already existed; what was missing was one place to stand.
 */

type Section = 'overview' | 'data' | 'mapping' | 'transformations' | 'dependencies' | 'runs';

const SECTIONS: { value: Section; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'data', label: 'Data' },
  { value: 'mapping', label: 'Mapping' },
  { value: 'transformations', label: 'Transformations' },
  { value: 'dependencies', label: 'Dependencies' },
  { value: 'runs', label: 'Runs' },
];

const STATUS_TONES: Record<MigrationProjectStatus, 'slate' | 'blue' | 'amber' | 'teal' | 'red'> = {
  DRAFT: 'slate',
  PREPARING: 'blue',
  BLOCKED: 'red',
  READY: 'teal',
  RUNNING: 'blue',
  COMPLETED_WITH_ISSUES: 'amber',
  COMPLETED: 'teal',
};

export function MigrationWorkspacePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const section = (params.get('section') as Section) || 'overview';
  const setSection = (next: Section) => setParams(next === 'overview' ? {} : { section: next });

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDto>('GET', `/api/projects/${projectId}`),
  });
  const workspace = useQuery({
    queryKey: ['migration-workspace', projectId],
    queryFn: () => api<MigrationWorkspaceDto>('GET', `/api/projects/${projectId}/migration`),
    // A run in flight changes the answer, so the answer refreshes while one is.
    refetchInterval: (query) => (query.state.data?.status === 'RUNNING' ? 4000 : false),
  });

  if (project.isLoading || workspace.isLoading) return <Spinner label="Opening the migration…" />;
  if (project.error) return <ErrorState error={project.error} />;
  if (workspace.error) return <ErrorState error={workspace.error} />;
  const w = workspace.data!;

  return (
    <>
      <PageHeader
        title={w.projectName}
        description={
          w.description ??
          'Move defined data from one place to another, with the evidence to know what will happen.'
        }
        actions={
          <span data-testid="migration-status">
            <Pill tone={STATUS_TONES[w.status]}>{MIGRATION_PROJECT_STATUS_LABELS[w.status]}</Pill>
          </span>
        }
      />

      <Ends source={w.source} target={w.target} />

      {/*
        The analysis this migration starts from. Worth a line rather than a card: it is provenance for the
        mapping workbook, which is a thing you check once and then stop thinking about.
      */}
      {project.data?.analysisProject && (
        <p className="-mt-2 mb-5 text-xs text-slate-500" data-testid="migration-based-on">
          Based on{' '}
          <Link
            to={`/analysis/${project.data.analysisProject.id}`}
            className="text-brand-700 hover:underline"
          >
            {project.data.analysisProject.name}
          </Link>
          , whose measurements fill the mapping workbook.
        </p>
      )}

      <div className="mb-5">
        <Tabs<Section> value={section} onChange={setSection} tabs={SECTIONS} />
      </div>

      {section === 'overview' && <Overview w={w} onSection={setSection} />}
      {section === 'data' && <MigrationData w={w} />}
      {section === 'mapping' && <MigrationMapping w={w} />}
      {section === 'transformations' && <MigrationTransformations w={w} />}
      {section === 'dependencies' && <MigrationDependencies w={w} />}
      {section === 'runs' && <MigrationRuns w={w} />}
    </>
  );
}

/**
 * The two ends, on the migration that owns them.
 *
 * Migration is the one place in this product where source and target are meaningful — and they belong to
 * the migration. The model this replaces made them application-wide, so a banner above every screen told
 * you which environment was "the source" even while you were reading an audit log.
 */
function Ends({
  source,
  target,
}: {
  source: MigrationWorkspaceDto['source'];
  target: MigrationWorkspaceDto['target'];
}) {
  return (
    <div className="mb-5 flex flex-wrap items-stretch gap-3" data-testid="migration-ends">
      <End label="Source" env={source} icon={<Database className="h-4 w-4" />} missing="No source data yet" />
      <span className="flex items-center text-slate-300">
        <ArrowRight className="h-5 w-5" aria-hidden />
      </span>
      <End label="Destination" env={target} icon={<Server className="h-4 w-4" />} missing="Not selected" />
    </div>
  );
}

function End({
  label,
  env,
  icon,
  missing,
}: {
  label: string;
  env: MigrationWorkspaceDto['source'];
  icon: React.ReactNode;
  missing: string;
}) {
  return (
    <div className="min-w-56 flex-1 rounded-lg border border-slate-200 bg-white px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      {env ? (
        <>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <span className="text-slate-400">{icon}</span>
            {env.displayName}
          </p>
          <p className="truncate text-xs text-slate-500">{env.url}</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-amber-800">{missing}</p>
      )}
    </div>
  );
}

/**
 * The thirty-second answer.
 *
 * What, from where, to where, how much, are we ready, what is blocking, what happened last time, what
 * next. Eight questions, one screen, in that order — because that is the order somebody asks them in.
 */
function Overview({ w, onSection }: { w: MigrationWorkspaceDto; onSection: (s: Section) => void }) {
  if (!w.plan || w.plan.datasets === 0 || !w.target) {
    return <EmptyMigration w={w} onSection={onSection} />;
  }

  return (
    <div className="space-y-5">
      {/*
        The one thing to do next, first.
        It was at the bottom, which on a 1440-wide laptop put the only sentence that tells somebody what
        to do below the fold, underneath three cards telling them what is true.
      */}
      <Card data-testid="migration-next-action">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Next action</p>
            <p className="mt-0.5 text-base font-semibold text-slate-900">{w.nextAction.label}</p>
            <p className="mt-0.5 text-sm text-slate-600">{w.nextAction.detail}</p>
          </div>
          <NextActionControls w={w} onSection={onSection} />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Scope" data-testid="migration-scope">
          <p className="text-2xl font-semibold text-slate-900">{describeCount(w.plan.datasets, 'dataset')}</p>
          <p className="mt-0.5 text-sm text-slate-500">
            {w.plan.records === null
              ? 'Records not counted yet'
              : `${w.plan.records.toLocaleString()} records`}
          </p>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => onSection('data')}>
            What exactly is moving?
          </Button>
        </Card>

        <Card title="Readiness" data-testid="migration-readiness">
          {w.readiness ? (
            <>
              <p
                className={cx(
                  'text-2xl font-semibold',
                  w.readiness.verdict.startsWith('BLOCKED') ? 'text-red-700' : 'text-emerald-700',
                )}
              >
                {w.readiness.verdict.startsWith('BLOCKED')
                  ? 'Not ready'
                  : w.readiness.warnings > 0
                    ? 'Ready with warnings'
                    : 'Ready'}
              </p>
              <p className="mt-0.5 text-sm text-slate-500">
                {w.readiness.blockers > 0 && (
                  <span className="font-medium text-red-700">
                    {describeCount(w.readiness.blockers, 'blocker')}
                  </span>
                )}
                {w.readiness.blockers > 0 && w.readiness.warnings > 0 && ' · '}
                {w.readiness.warnings > 0 && `${describeCount(w.readiness.warnings, 'warning')}`}
                {w.readiness.blockers === 0 && w.readiness.warnings === 0 && 'Nothing outstanding'}
              </p>
            </>
          ) : (
            <>
              <p className="text-2xl font-semibold text-slate-400">Not assessed</p>
              <p className="mt-0.5 text-sm text-slate-500">Nothing has checked this configuration yet.</p>
            </>
          )}
        </Card>

        <Card title="Last run" data-testid="migration-last-run">
          {w.lastRun ? (
            <>
              <p className="text-2xl font-semibold text-slate-900">{runLabel(w.lastRun.status)}</p>
              <p className="mt-0.5 text-sm text-slate-500">
                {w.lastRun.succeeded.toLocaleString()} succeeded
                {w.lastRun.failed > 0 && (
                  <span className="text-red-700"> · {w.lastRun.failed.toLocaleString()} failed</span>
                )}
              </p>
              <Link
                to={`/runs/${w.lastRun.id}`}
                className="mt-2 inline-block text-sm text-brand-700 hover:underline"
              >
                Open run →
              </Link>
            </>
          ) : (
            <>
              <p className="text-2xl font-semibold text-slate-400">None yet</p>
              <p className="mt-0.5 text-sm text-slate-500">This migration has not been run.</p>
            </>
          )}
        </Card>
      </div>

      {w.readiness && w.readiness.top.length > 0 && (
        <Card
          title={w.readiness.blockers > 0 ? 'Biggest blockers' : 'Worth knowing before you run'}
          subtitle="Each one names what was observed, why it matters, and what to do."
          data-testid="migration-blockers"
        >
          <ul className="space-y-3">
            {w.readiness.top.map((finding) => (
              <FindingRow key={`${finding.code}:${finding.object?.name ?? ''}`} finding={finding} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/**
 * Doing the next thing, from the place that said what it was.
 *
 * Execution lives here rather than at the end of a wizard, because "can we run this" is a question people
 * ask repeatedly and from a standing start — the day before the cutover, and again on the morning of it.
 * The preflight is the checkpoint before anything is written; the engine refuses a run with blockers
 * whatever this button does.
 */
function NextActionControls({ w, onSection }: { w: MigrationWorkspaceDto; onSection: (s: Section) => void }) {
  const [executing, setExecuting] = useState(false);
  const navigate = useNavigate();
  const plan = useQuery({
    queryKey: ['migration-plan', w.projectId],
    queryFn: () => api<MigrationPlanDto | null>('GET', `/api/projects/${w.projectId}/migration/plan`),
    enabled: Boolean(w.plan),
  });

  const kind = w.nextAction.kind;
  if (kind === 'RESOLVE_BLOCKERS' || kind === 'REVIEW_WARNINGS') {
    return (
      <Button variant="secondary" onClick={() => onSection('mapping')}>
        Open mapping
      </Button>
    );
  }
  if (kind === 'REVIEW_FAILURES' && w.lastRun) {
    return (
      <Button variant="primary" onClick={() => navigate(`/runs/${w.lastRun!.id}`)}>
        Review the failures
      </Button>
    );
  }
  if (kind === 'WATCH_RUN' && w.lastRun) {
    return (
      <Button variant="primary" onClick={() => navigate(`/runs/${w.lastRun!.id}`)}>
        Watch this run
      </Button>
    );
  }
  if (kind !== 'EXECUTE' || !plan.data) return null;

  return (
    <div className="flex flex-none flex-wrap gap-2">
      <Link
        to={`/migration/plans/${plan.data.id}/preflight`}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        data-testid="open-preflight"
      >
        Preflight (dry run)
      </Link>
      <Button variant="primary" data-testid="start-migration" onClick={() => setExecuting(true)}>
        Start migration
      </Button>
      <ExecuteModal
        plan={plan.data}
        open={executing}
        onClose={() => setExecuting(false)}
        onStarted={(run) => navigate(`/runs/${run.id}`)}
      />
    </div>
  );
}

/** One readiness finding, in the three sentences it already carries. */
function FindingRow({ finding }: { finding: ReadinessFinding }) {
  const blocker = finding.severity === 'BLOCKER';
  return (
    <li className="flex gap-3" data-testid="readiness-finding">
      <span
        className={cx(
          'mt-0.5 h-2 w-2 flex-none rounded-full',
          blocker ? 'bg-red-600' : finding.severity === 'WARNING' ? 'bg-amber-500' : 'bg-slate-300',
        )}
        aria-hidden
      />
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">
          {finding.object?.name ? `${finding.object.name}: ` : ''}
          {finding.explanation}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">{finding.evidence}</p>
        <p className="mt-0.5 text-xs text-brand-800">{finding.recommendation}</p>
      </div>
    </li>
  );
}

/**
 * A migration with nothing in it yet.
 *
 * Two things to do, in whichever order suits the person. Deliberately not "Step 1 incomplete": a new
 * project is not broken, it is empty, and those read very differently to somebody who has just made one.
 */
function EmptyMigration({ w, onSection }: { w: MigrationWorkspaceDto; onSection: (s: Section) => void }) {
  const hasData = Boolean(w.plan && w.plan.datasets > 0);
  return (
    <Card data-testid="migration-empty">
      <EmptyState
        icon={<Layers className="h-8 w-8" />}
        title="Start your migration"
        description="Set this up by adding the data you want to move and choosing where it should go. Either order is fine."
      />
      <div className="mx-auto mt-2 grid max-w-2xl gap-3 sm:grid-cols-2">
        <Step
          n={1}
          title="Add source data"
          done={hasData}
          detail={hasData ? describeCount(w.plan!.datasets, 'dataset') : 'Choose what you want to move.'}
          action={
            <Button variant={hasData ? 'secondary' : 'primary'} onClick={() => onSection('data')}>
              {hasData ? 'Review source data' : 'Add source data'}
            </Button>
          }
        />
        <Step
          n={2}
          title="Choose destination"
          done={Boolean(w.target)}
          detail={w.target ? w.target.displayName : 'Select where this data should go.'}
          action={
            <Button variant={w.target ? 'secondary' : 'primary'} onClick={() => onSection('data')}>
              {w.target ? 'Change destination' : 'Choose destination'}
            </Button>
          }
        />
      </div>
      <p className="mt-5 text-center text-sm text-slate-500">
        Migration readiness: <span className="font-medium text-slate-700">not assessed yet</span>
      </p>
    </Card>
  );
}

function Step({
  n,
  title,
  detail,
  done,
  action,
}: {
  n: number;
  title: string;
  detail: string;
  done: boolean;
  action: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
      <span
        className={cx(
          'mx-auto flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold',
          done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500',
        )}
      >
        {n}
      </span>
      <h3 className="mt-2 text-sm font-semibold text-slate-900">{title}</h3>
      <p className="mt-0.5 text-xs text-slate-500">{detail}</p>
      <div className="mt-3">{action}</div>
    </div>
  );
}

const runLabel = (status: MigrationRunStatus): string =>
  status === 'COMPLETED'
    ? 'Completed'
    : status === 'COMPLETED_WITH_ERRORS'
      ? 'Completed with issues'
      : status === 'RUNNING'
        ? 'Running'
        : status === 'QUEUED'
          ? 'Queued'
          : status === 'FAILED'
            ? 'Failed'
            : status === 'CANCELLED'
              ? 'Cancelled'
              : status === 'PAUSED'
                ? 'Paused'
                : 'Needs reconciliation';
