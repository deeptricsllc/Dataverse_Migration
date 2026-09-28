import {
  PROJECT_KIND_LABELS,
  type AnalysisRunDto,
  type AnalysisRunListItemDto,
  type ProjectDto,
} from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TableSummary } from '@shared/metadata';
import { Archive, ArrowRight, FileSpreadsheet, Microscope, Play, Plus, Truck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ComparisonProject } from '../components/ComparisonProject';
import { get, post } from '../lib/api';
import { fmtDate, fmtNumber, fmtRelative } from '../lib/format';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  ExportButton,
  Modal,
  PageHeader,
  Pill,
  SearchInput,
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../components/ui';

/** How often to re-check a running analysis. */
const POLL_MS = 2000;

const KIND_TONES = { ANALYSIS: 'violet', MIGRATION: 'blue', COMPARISON: 'amber' } as const;

/**
 * One project. An analysis project shows its analyses; a migration project shows its plans and the
 * analysis it was built on; a comparison project shows its reconciliation runs. The page never
 * offers a write action on work that only ever reads.
 */
export function ProjectPage() {
  const { projectId = '' } = useParams();
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => get<ProjectDto>(`/api/projects/${projectId}`),
  });

  if (project.isLoading) return <Spinner label="Loading project…" />;
  if (project.error) return <ErrorState error={project.error} onRetry={() => project.refetch()} />;
  if (!project.data) return null;
  const p = project.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={p.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Pill tone={KIND_TONES[p.kind]}>{PROJECT_KIND_LABELS[p.kind]}</Pill>
            {p.status === 'ARCHIVED' && <Pill tone="slate">archived</Pill>}
            <span className="text-slate-500">
              {p.sourceEnvironment?.displayName ?? 'no source'}
              {p.targetEnvironment ? ` → ${p.targetEnvironment.displayName}` : ''}
            </span>
            {p.description && <span className="text-slate-500">· {p.description}</span>}
          </span>
        }
        actions={
          <Link to="/projects" className="text-sm text-brand-700 hover:underline">
            All projects
          </Link>
        }
      />

      {!p.sourceEnvironment && p.kind !== 'COMPARISON' && (
        <Callout tone="warning" title="This project has no source yet">
          Choose the system it works on from the Connections page, then come back.
        </Callout>
      )}

      {p.kind === 'ANALYSIS' && <AnalysisProject project={p} />}
      {p.kind === 'MIGRATION' && <MigrationProject project={p} />}
      {p.kind === 'COMPARISON' && <ComparisonProject project={p} />}

      <ArchiveCard project={p} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analysis projects
// ---------------------------------------------------------------------------

function AnalysisProject({ project }: { project: ProjectDto }) {
  const [starting, setStarting] = useState(false);
  const analyses = useQuery({
    queryKey: ['analyses', project.id],
    queryFn: () => get<AnalysisRunListItemDto[]>(`/api/projects/${project.id}/analyses`),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((a) => a.status === 'QUEUED' || a.status === 'RUNNING') ? POLL_MS : false,
  });

  const latest = (analyses.data ?? []).find((a) => a.status === 'COMPLETED');

  return (
    <div className="space-y-5">
      <Card
        title="Analyses"
        subtitle="Each analysis is a point-in-time read of the source. Run as many as you need — nothing is overwritten."
        data-testid="analyses"
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Play className="h-3.5 w-3.5" />}
            disabled={!project.sourceEnvironment}
            data-testid="new-analysis"
            onClick={() => setStarting(true)}
          >
            Run an analysis
          </Button>
        }
      >
        {analyses.isLoading && <Spinner label="Loading analyses…" />}
        {analyses.error && <ErrorState error={analyses.error} />}
        {analyses.data?.length === 0 && (
          <EmptyState
            icon={<Microscope className="h-6 w-6" />}
            title="Nothing analysed yet"
            description="An analysis reads the source and reports its tables, columns, volumes, data quality and relationships."
            action={
              <Button
                variant="primary"
                disabled={!project.sourceEnvironment}
                onClick={() => setStarting(true)}
              >
                Run an analysis
              </Button>
            }
          />
        )}
        {(analyses.data?.length ?? 0) > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Analysis</Th>
                <Th>Status</Th>
                <Th className="text-right">Tables</Th>
                <Th className="text-right">Records</Th>
                <Th className="text-right">Findings</Th>
                <Th>Statistics</Th>
                <Th>Run</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {analyses.data!.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <Td>
                    <Link to={`/analyses/${a.id}`} className="font-medium text-brand-700 hover:underline">
                      {a.name}
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge status={a.status} />
                  </Td>
                  <Td className="text-right tabular-nums">{fmtNumber(a.totals.tables)}</Td>
                  <Td className="text-right tabular-nums">
                    {fmtNumber(a.totals.records)}
                    {a.totals.recordsApproximate && <span className="text-slate-400">≈</span>}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {a.totals.blockers > 0 && <Pill tone="red">{a.totals.blockers}</Pill>}{' '}
                    {a.totals.warnings > 0 && <Pill tone="amber">{a.totals.warnings}</Pill>}
                    {a.totals.blockers === 0 && a.totals.warnings === 0 && '—'}
                  </Td>
                  <Td>
                    {a.basis ? (
                      <span className={a.basis === 'EXACT' ? 'text-emerald-700' : 'text-amber-700'}>
                        {a.basis === 'EXACT' ? 'exact' : 'sampled'}
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="text-xs text-slate-500">{fmtRelative(a.createdAt)}</Td>
                  <Td>
                    <Link to={`/analyses/${a.id}`} aria-label={`Open ${a.name}`}>
                      <ArrowRight className="h-4 w-4 text-slate-400" />
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {latest && (
        <Card
          title="Mapping workbook"
          subtitle="The source half of a mapping, as a spreadsheet. Send it to the people who know what these columns mean."
          actions={
            <ExportButton
              href={`/api/analyses/${latest.id}/mapping.xlsx`}
              label="Download workbook"
              size="md"
            />
          }
        >
          <p className="text-sm text-slate-600">
            Four sheets: an overview, the tables with their load order, every column with what was actually
            measured in it, and the findings. Fill in the Target table and Target field columns, then import
            it into a migration project to apply them.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <ExportButton href={`/api/analyses/${latest.id}/tables.csv`} label="Tables (CSV)" />
            <ExportButton href={`/api/analyses/${latest.id}/columns.csv`} label="Columns (CSV)" />
            <ExportButton href={`/api/analyses/${latest.id}/findings.csv`} label="Findings (CSV)" />
          </div>
        </Card>
      )}

      <NewAnalysisModal project={project} open={starting} onClose={() => setStarting(false)} />
    </div>
  );
}

function NewAnalysisModal({
  project,
  open,
  onClose,
}: {
  project: ProjectDto;
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [full, setFull] = useState(true);

  const tables = useQuery({
    queryKey: ['source-tables', project.id],
    queryFn: () => get<TableSummary[]>(`/api/projects/${project.id}/source-tables`),
    enabled: open,
  });

  const filtered = useMemo(() => {
    const all = tables.data ?? [];
    const q = search.trim().toLowerCase();
    return q
      ? all.filter((t) => t.logicalName.toLowerCase().includes(q) || t.displayName.toLowerCase().includes(q))
      : all;
  }, [tables.data, search]);

  const start = useMutation({
    mutationFn: () =>
      post<AnalysisRunDto>(`/api/projects/${project.id}/analyses`, {
        name: name || undefined,
        tables: [...selected],
        full,
      }),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: ['analyses', project.id] });
      onClose();
      navigate(`/analyses/${run.id}`);
    },
  });

  const toggle = (logicalName: string) => {
    const next = new Set(selected);
    if (next.has(logicalName)) next.delete(logicalName);
    else next.add(logicalName);
    setSelected(next);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Run an analysis"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={start.isPending}
            data-testid="start-analysis"
            onClick={() => start.mutate()}
          >
            {selected.size === 0
              ? 'Analyse every table'
              : `Analyse ${selected.size} table${selected.size === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="analysis-name">
            Name <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            id="analysis-name"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            value={name}
            placeholder="Customers and orders"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <Checkbox
          checked={full}
          onChange={setFull}
          label="Examine every record (slower, but the counts are exact rather than a floor)"
        />

        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-slate-700">
              Tables{' '}
              <span className="font-normal text-slate-500">
                {selected.size === 0 ? '— all of them' : `— ${selected.size} selected`}
              </span>
            </span>
            <SearchInput value={search} onChange={setSearch} placeholder="Filter tables…" />
          </div>
          {tables.isLoading && <Spinner label="Reading the source catalogue…" />}
          {tables.error && <ErrorState error={tables.error} />}
          {tables.data && (
            <div className="max-h-72 overflow-y-auto rounded-md border border-slate-200">
              {filtered.map((t) => (
                <div
                  key={t.logicalName}
                  className="flex items-center justify-between border-b border-slate-100 px-3 py-1.5 last:border-0"
                >
                  <Checkbox
                    checked={selected.has(t.logicalName)}
                    onChange={() => toggle(t.logicalName)}
                    label={t.displayName}
                  />
                  <span className="font-mono text-xs text-slate-400">{t.logicalName}</span>
                </div>
              ))}
              {filtered.length === 0 && (
                <p className="px-3 py-3 text-sm text-slate-500">No table matches that.</p>
              )}
            </div>
          )}
          <p className="mt-1.5 text-xs text-slate-500">
            Selecting nothing analyses every table the source exposes, up to 200.
          </p>
        </div>
        {start.error && <ErrorState error={start.error} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Migration projects
// ---------------------------------------------------------------------------

function MigrationProject({ project }: { project: ProjectDto }) {
  const plans = useQuery({
    queryKey: ['project-plans', project.id],
    queryFn: () =>
      get<
        {
          id: string;
          name: string;
          status: string;
          tableCount: number;
          blockerCount: number;
          updatedAt: string;
        }[]
      >(`/api/projects/${project.id}/plans`),
  });
  const analysis = useQuery({
    queryKey: ['project-analysis', project.analysisProject?.id],
    queryFn: () => get<AnalysisRunListItemDto[]>(`/api/projects/${project.analysisProject!.id}/analyses`),
    enabled: Boolean(project.analysisProject),
  });
  const latestAnalysis = (analysis.data ?? []).find((a) => a.status === 'COMPLETED');

  return (
    <div className="space-y-5">
      {project.analysisProject && (
        <Card
          title="Based on"
          subtitle="The analysis this migration starts from. Its measurements fill the mapping workbook."
          actions={
            <Link
              to={`/projects/${project.analysisProject.id}`}
              className="text-sm text-brand-700 hover:underline"
            >
              Open analysis project
            </Link>
          }
        >
          {analysis.isLoading && <Spinner label="Loading the analysis…" />}
          {!latestAnalysis && !analysis.isLoading && (
            <Callout tone="info" title="No completed analysis yet">
              Run an analysis in{' '}
              <Link to={`/projects/${project.analysisProject.id}`} className="underline">
                {project.analysisProject.name}
              </Link>{' '}
              and its findings will appear here and in the mapping workbook.
            </Callout>
          )}
          {latestAnalysis && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Tables" value={fmtNumber(latestAnalysis.totals.tables)} />
              <Stat label="Records" value={fmtNumber(latestAnalysis.totals.records)} />
              <Stat
                label="Blockers"
                value={fmtNumber(latestAnalysis.totals.blockers)}
                tone={latestAnalysis.totals.blockers > 0 ? 'red' : 'green'}
              />
              <Stat
                label="Warnings"
                value={fmtNumber(latestAnalysis.totals.warnings)}
                tone={latestAnalysis.totals.warnings > 0 ? 'amber' : 'green'}
              />
              <div className="col-span-2 sm:col-span-4">
                <Link
                  to={`/analyses/${latestAnalysis.id}`}
                  className="text-sm text-brand-700 hover:underline"
                >
                  {latestAnalysis.name} →
                </Link>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card
        title="Migration plans"
        subtitle="Each plan maps a set of tables and runs them. Preflight, execute and validate live inside a plan."
        data-testid="project-plans"
        actions={
          <Link
            to={`/migration/new?projectId=${project.id}`}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:bg-brand-700"
          >
            <Plus className="h-3.5 w-3.5" />
            New plan
          </Link>
        }
      >
        {plans.isLoading && <Spinner label="Loading plans…" />}
        {plans.error && <ErrorState error={plans.error} />}
        {plans.data?.length === 0 && (
          <EmptyState
            icon={<Truck className="h-6 w-6" />}
            title="No plans in this project"
            description={
              latestAnalysis
                ? 'Create a plan and its mapping workbook will already carry what the analysis measured.'
                : 'Create a plan to choose tables, map fields and run the migration.'
            }
            action={
              <Link
                to={`/migration/new?projectId=${project.id}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
              >
                New plan
              </Link>
            }
          />
        )}
        {(plans.data?.length ?? 0) > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Plan</Th>
                <Th>Status</Th>
                <Th className="text-right">Tables</Th>
                <Th className="text-right">Blockers</Th>
                <Th>Updated</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {plans.data!.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <Td>
                    <Link
                      to={`/migration/plans/${p.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {p.name}
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge status={p.status} />
                  </Td>
                  <Td className="text-right tabular-nums">{fmtNumber(p.tableCount)}</Td>
                  <Td className="text-right tabular-nums">
                    {p.blockerCount > 0 ? <Pill tone="red">{p.blockerCount}</Pill> : '—'}
                  </Td>
                  <Td className="text-xs text-slate-500">{fmtRelative(p.updatedAt)}</Td>
                  <Td>
                    <div className="flex items-center gap-3">
                      <a
                        href={`/api/plans/${p.id}/mapping.xlsx`}
                        download
                        title="Mapping workbook"
                        className="text-slate-400 hover:text-slate-700"
                      >
                        <FileSpreadsheet className="h-4 w-4" />
                      </a>
                      <Link to={`/migration/plans/${p.id}`} aria-label={`Open ${p.name}`}>
                        <ArrowRight className="h-4 w-4 text-slate-400" />
                      </Link>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function ArchiveCard({ project }: { project: ProjectDto }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const archive = useMutation({
    mutationFn: () => post<ProjectDto>(`/api/projects/${project.id}/archive`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['project', project.id] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      setConfirming(false);
    },
  });
  if (project.status === 'ARCHIVED') return null;

  return (
    <>
      <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-xs text-slate-500">
          Created {fmtDate(project.createdAt)}
          {project.createdBy ? ` by ${project.createdBy}` : ''}. Archiving hides the project without deleting
          anything it holds.
        </p>
        <Button size="sm" icon={<Archive className="h-3.5 w-3.5" />} onClick={() => setConfirming(true)}>
          Archive
        </Button>
      </div>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Archive ${project.name}?`}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="danger" loading={archive.isPending} onClick={() => archive.mutate()}>
              Archive
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          The project leaves the default list. Everything inside it — analyses, plans, runs — stays readable,
          because decisions were made on it.
        </p>
        {archive.error && <ErrorState error={archive.error} />}
      </Modal>
    </>
  );
}
