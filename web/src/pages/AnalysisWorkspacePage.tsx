import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, FileSpreadsheet, Plus, Search, Table2 } from 'lucide-react';
import type {
  AnalysisAssessmentDto,
  AnalysisRunSummaryDto,
  AssessedDatasetDto,
  DatasetAnalysisState,
  ProjectDto,
} from '@shared/domain';
import type { Finding, FindingDisposition, FindingSeverity } from '@shared/findings';
import { FINDING_CATEGORIES, FINDING_CATEGORY_LABELS, type FindingCategory } from '@shared/findings';
import { AddDatasetDrawer } from '../components/AddDatasetDrawer';
import { FindingCard, SeverityChip } from '../components/FindingCard';
import { ReadinessPanel } from '../components/ReadinessPanel';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  Spinner,
  Tabs,
  cx,
} from '../components/ui';
import { api } from '../lib/api';
import { fmtRelative } from '../lib/format';

/**
 * An analysis project: what is in these datasets, and what should be known about them.
 *
 * The screen leads with the answer. A reader arriving here wants "what did you find?", not a table of
 * column statistics, so the first thing on the page is the verdict in a sentence, then the readiness, then
 * the findings in the order they ought to be read. Everything numeric is underneath.
 *
 * **There is no source and no target anywhere in this workspace**, and that is the point of it existing
 * separately. An analysis has datasets. Nothing here writes anywhere, so nothing here asks where to.
 */

type Section = 'overview' | 'datasets' | 'findings';

export function AnalysisWorkspacePage() {
  const { projectId = '' } = useParams();
  const [section, setSection] = useState<Section>('overview');
  const [adding, setAdding] = useState(false);
  const queryClient = useQueryClient();

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDto>('GET', `/api/projects/${projectId}`),
  });
  const assessment = useQuery({
    queryKey: ['assessment', projectId],
    queryFn: () => api<AnalysisAssessmentDto>('GET', `/api/projects/${projectId}/assessment`),
    /**
     * Analysis is queued, so the page has to find out when it finishes.
     *
     * Polled only while something is actually running, rather than on a permanent timer — a workspace
     * that re-fetches for ever is the kind of thing nobody notices until a browser tab has been open all
     * day. Two seconds is fast enough that "Analysing" does not feel stuck.
     */
    refetchInterval: (query) => {
      const data = query.state.data as AnalysisAssessmentDto | undefined;
      const busy = data?.datasets.some((d) => d.state === 'QUEUED' || d.state === 'RUNNING');
      return busy ? 2000 : false;
    },
  });

  const analyse = useMutation({
    mutationFn: (all: boolean) => api('POST', `/api/projects/${projectId}/analyse`, { all }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assessment', projectId] }),
  });

  if (project.isLoading || assessment.isLoading) return <Spinner label="Loading the assessment…" />;
  if (project.error) return <ErrorState error={project.error} onRetry={() => project.refetch()} />;
  if (assessment.error) return <ErrorState error={assessment.error} onRetry={() => assessment.refetch()} />;
  const data = assessment.data!;
  const analysed = data.datasets.filter((d) => d.analysed).length;

  return (
    <div>
      <PageHeader
        title={project.data!.name}
        description={
          project.data!.description ?? 'Understand these datasets before deciding how to migrate them.'
        }
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Plus className="h-4 w-4" />}
              data-testid="add-dataset"
              onClick={() => setAdding(true)}
            >
              Add dataset
            </Button>
            <AnalyseButton
              datasets={data.datasets}
              running={analyse.isPending}
              onAnalyse={(all) => analyse.mutate(all)}
            />
          </>
        }
      />

      {/* The scale of what was looked at, in the words a person would use. */}
      <p className="-mt-3 mb-5 text-sm text-slate-500">
        {/*
          Table and record counts are only known once something has been analysed. Printing "0 tables ·
          0 records" beside three files that plainly contain data reads as "these files are empty",
          which is both wrong and the opposite of reassuring.
        */}
        {data.datasets.length === 0
          ? 'No datasets yet.'
          : analysed === 0
            ? describeCount(data.datasets.length, 'dataset')
            : `${describeCount(data.datasets.length, 'dataset')} · ${describeCount(data.tables, 'table')} · ${data.records.toLocaleString()} records`}
        {analysed < data.datasets.length && data.datasets.length > 0 && (
          <span className="text-amber-700"> · {data.datasets.length - analysed} not analysed yet</span>
        )}
      </p>

      <div className="mb-5">
        <Tabs<Section>
          value={section}
          onChange={setSection}
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'datasets', label: `Datasets (${data.datasets.length})` },
            { value: 'findings', label: `Findings (${data.findings.length})` },
          ]}
        />
      </div>

      {section === 'overview' && (
        <Overview
          data={data}
          onSeeAll={() => setSection('findings')}
          onAddDataset={() => setAdding(true)}
          onAnalyse={() => analyse.mutate(false)}
        />
      )}
      {section === 'datasets' && (
        <Datasets
          datasets={data.datasets}
          runs={data.runs}
          onAddDataset={() => setAdding(true)}
          onAnalyseAll={() => analyse.mutate(true)}
        />
      )}
      {section === 'findings' && (
        <FindingsWorkspace
          projectId={projectId}
          findings={data.findings}
          dispositions={data.dispositions}
          datasets={data.datasets}
        />
      )}

      <AddDatasetDrawer project={project.data!} open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

/**
 * The one obvious next action, which depends on where the project has got to.
 *
 * Nothing analysed yet, something changed since it was, or everything up to date are three different
 * situations, and a button that says "Analyse" in all three leaves the user to work out which they are
 * in. The count of what needs doing is on the button.
 */
function AnalyseButton({
  datasets,
  running,
  onAnalyse,
}: {
  datasets: AssessedDatasetDto[];
  running: boolean;
  onAnalyse: (all: boolean) => void;
}) {
  if (datasets.length === 0) return null;
  const busy = datasets.filter((d) => d.state === 'QUEUED' || d.state === 'RUNNING').length;
  const pending = datasets.filter(
    (d) => d.state === 'NOT_ANALYSED' || d.state === 'STALE' || d.state === 'FAILED',
  ).length;

  if (busy > 0) {
    return (
      <Button variant="primary" disabled loading data-testid="analyse">
        Analysing {busy} of {datasets.length}
      </Button>
    );
  }
  return (
    <Button
      variant="primary"
      loading={running}
      data-testid="analyse"
      onClick={() => onAnalyse(pending === 0)}
    >
      {pending === 0
        ? 'Re-analyse'
        : pending === datasets.length
          ? `Analyse ${datasets.length === 1 ? 'dataset' : `${datasets.length} datasets`}`
          : `Analyse ${pending} of ${datasets.length}`}
    </Button>
  );
}

const describeCount = (n: number, noun: string) => `${n.toLocaleString()} ${n === 1 ? noun : `${noun}s`}`;

// ---------------------------------------------------------------------------

function Overview({
  data,
  onSeeAll,
  onAddDataset,
  onAnalyse,
}: {
  data: AnalysisAssessmentDto;
  onSeeAll: () => void;
  onAddDataset: () => void;
  onAnalyse: () => void;
}) {
  if (data.datasets.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Database className="h-8 w-8" />}
          title="Add your first dataset"
          description="A spreadsheet, a CSV export, a database or a Dataverse environment. Add as many as the question needs — this project is about all of them together, and nothing is ever written back."
          action={
            <Button variant="primary" onClick={onAddDataset}>
              Add dataset
            </Button>
          }
        />
      </Card>
    );
  }

  const unanalysed = data.datasets.filter((d) => !d.analysed);
  const busy = data.datasets.some((d) => d.state === 'QUEUED' || d.state === 'RUNNING');
  const stale = data.datasets.filter((d) => d.state === 'STALE');

  /**
   * Datasets exist but none has been analysed, so there is nothing to report yet.
   *
   * Said as the next step rather than as an absence: "no findings" on a project nobody has analysed
   * reads as a clean bill of health, which is the opposite of the truth.
   */
  if (data.datasets.every((d) => !d.analysed)) {
    return (
      <Card>
        <EmptyState
          icon={<Database className="h-8 w-8" />}
          title={busy ? 'Analysing your data…' : 'Nothing has been analysed yet'}
          description={
            busy
              ? 'Reading every column, counting what is missing, looking for keys and duplicates. This page updates when it finishes.'
              : `Analyse ${unanalysed.length === 1 ? 'this dataset' : `these ${unanalysed.length} datasets`} to discover migration risks, data-quality problems, structural issues and how ready the data is.`
          }
          action={
            busy ? undefined : (
              <Button variant="primary" onClick={onAnalyse}>
                Analyse {unanalysed.length === 1 ? 'dataset' : `${unanalysed.length} datasets`}
              </Button>
            )
          }
        />
      </Card>
    );
  }

  /** The findings worth leading with: everything critical, then warnings, capped so the page stays readable. */
  const top = data.findings.filter((f) => f.severity !== 'INFO').slice(0, 5);

  return (
    <div className="space-y-5">
      {stale.length > 0 && (
        /*
         * The findings below describe data that has since changed. Showing them without saying so is how
         * somebody acts on an assessment of a file that no longer exists.
         */
        <Callout
          tone="warning"
          title={`${stale.length === 1 ? 'A dataset has' : `${stale.length} datasets have`} changed since this analysis`}
        >
          {stale.map((d) => d.name).join(', ')} {stale.length === 1 ? 'was' : 'were'} updated after the
          analysis ran, so what follows may be out of date. Re-analyse to bring it up to date.
        </Callout>
      )}

      {/* The paragraph. Assembled from the findings, so it cannot say anything they do not support. */}
      <Card title="What we found">
        <p data-testid="executive-summary" className="max-w-4xl text-[15px] leading-relaxed text-slate-700">
          {data.summary}
        </p>
      </Card>

      <ReadinessPanel readiness={data.readiness} findings={data.findings} />

      {top.length > 0 && (
        <section data-testid="top-findings">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              {data.readiness.counts.CRITICAL > 0 ? 'Resolve these first' : 'Worth resolving first'}
            </h2>
            <Button size="sm" variant="ghost" onClick={onSeeAll}>
              All {data.findings.length} findings
            </Button>
          </div>
          <div className="space-y-3">
            {top.map((finding) => (
              <FindingCard key={finding.id} finding={finding} defaultOpen={finding.severity === 'CRITICAL'} />
            ))}
          </div>
        </section>
      )}

      {top.length === 0 && (
        <Card>
          <EmptyState
            title="Nothing critical and nothing to warn about"
            description="The informational findings under the Findings tab are mapping decisions and observations rather than problems."
          />
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Datasets({
  datasets,
  runs,
  onAddDataset,
  onAnalyseAll,
}: {
  datasets: AssessedDatasetDto[];
  runs: AnalysisRunSummaryDto[];
  onAddDataset: () => void;
  onAnalyseAll: () => void;
}) {
  if (datasets.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Database className="h-8 w-8" />}
          title="No datasets in this project"
          description="Add a spreadsheet, a database or a Dataverse environment. Adding one here does not copy it — the connection stays a workspace asset, available to your other projects."
          action={
            <Button variant="primary" onClick={onAddDataset}>
              Add dataset
            </Button>
          }
        />
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {datasets.map((dataset) => (
        <Card key={dataset.environmentId} data-testid="dataset-card">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 gap-3">
              <span className="mt-0.5 flex-none text-slate-400">
                {dataset.connectionType === 'FILE' ? (
                  <FileSpreadsheet className="h-5 w-5" />
                ) : (
                  <Database className="h-5 w-5" />
                )}
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-900">{dataset.name}</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {datasetKindLabel(dataset)}
                  {dataset.analysed
                    ? ` · ${describeCount(dataset.tables, 'table')} · ${dataset.records.toLocaleString()} records`
                    : ' · not analysed yet'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4 text-sm">
              {dataset.analysed && (
                <>
                  {dataset.critical > 0 && (
                    <span className="font-semibold text-red-700">{dataset.critical} critical</span>
                  )}
                  {dataset.warning > 0 && (
                    <span className="font-semibold text-amber-800">{dataset.warning} warnings</span>
                  )}
                  {dataset.critical === 0 && dataset.warning === 0 && (
                    <span className="text-emerald-700">No problems found</span>
                  )}
                </>
              )}
              <DatasetState dataset={dataset} />
            </div>
          </div>
        </Card>
      ))}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="secondary" onClick={onAddDataset}>
          Add another dataset
        </Button>
        {datasets.some((d) => d.analysed) && (
          <Button variant="ghost" onClick={onAnalyseAll}>
            Re-analyse everything
          </Button>
        )}
      </div>

      <RunHistory runs={runs} />
    </div>
  );
}

/**
 * Where this dataset's analysis has got to, said plainly.
 *
 * `STALE` and `FAILED` are the two that matter: both look like "analysed" if all you show is a tick, and
 * both mean the numbers on screen should not be acted on.
 */
function DatasetState({ dataset }: { dataset: AssessedDatasetDto }) {
  const chip: Record<DatasetAnalysisState, { label: string; cls: string }> = {
    NOT_ANALYSED: { label: 'Not analysed', cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
    QUEUED: { label: 'Queued', cls: 'bg-sky-50 text-sky-700 ring-sky-200' },
    RUNNING: { label: 'Analysing…', cls: 'bg-sky-50 text-sky-700 ring-sky-200' },
    ANALYSED: { label: 'Analysed', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    STALE: { label: 'Changed since analysis', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
    FAILED: { label: 'Analysis failed', cls: 'bg-red-50 text-red-700 ring-red-200' },
  };
  const tone = chip[dataset.state];
  return (
    <span className="text-right">
      <span
        data-testid="dataset-state"
        className={cx(
          'inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset',
          tone.cls,
        )}
      >
        {tone.label}
      </span>
      {dataset.analysedAt && dataset.state !== 'RUNNING' && dataset.state !== 'QUEUED' && (
        <span className="mt-0.5 block text-[11px] text-slate-400">{fmtRelative(dataset.analysedAt)}</span>
      )}
      {dataset.failureMessage && (
        <span className="mt-0.5 block max-w-xs text-[11px] text-red-700">{dataset.failureMessage}</span>
      )}
    </span>
  );
}

/**
 * Every analysis this project has run.
 *
 * Deliberately a plain list rather than a diff viewer. The lineage question — "what did we know, and
 * when" — is answered by keeping the runs; comparing two of them is a later feature, and pretending to
 * offer it now would be worse than the list.
 */
function RunHistory({ runs }: { runs: AnalysisRunSummaryDto[] }) {
  if (runs.length === 0) return null;
  return (
    <Card title="Analysis history" subtitle="Each run covers one dataset. Newest first.">
      <ol className="space-y-1.5 text-sm">
        {runs.slice(0, 12).map((run) => (
          <li key={run.id} className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="text-slate-700">{run.datasetName}</span>
            <span className="text-xs text-slate-500">
              {run.status === 'COMPLETED'
                ? `${run.tables} ${run.tables === 1 ? 'table' : 'tables'} · ${run.records.toLocaleString()} records`
                : run.status.toLowerCase()}
              {' · '}
              {fmtRelative(run.completedAt ?? run.startedAt)}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** What kind of thing this dataset is, in a word a person would use rather than a connection type. */
function datasetKindLabel(dataset: AssessedDatasetDto): string {
  if (dataset.connectionType === 'FILE') return 'Files';
  if (dataset.connectionType === 'DATAVERSE') return 'Microsoft Dataverse';
  if (dataset.connectionType === 'SQL_SERVER') return 'SQL Server';
  if (dataset.connectionType === 'AZURE_SQL') return 'Azure SQL';
  if (dataset.connectionType === 'POSTGRES') return 'PostgreSQL';
  if (dataset.connectionType === 'MYSQL') return 'MySQL';
  return 'Dataset';
}

// ---------------------------------------------------------------------------

const SEVERITIES: FindingSeverity[] = ['CRITICAL', 'WARNING', 'INFO'];

function FindingsWorkspace({
  projectId,
  findings,
  dispositions,
  datasets,
}: {
  projectId: string;
  findings: Finding[];
  dispositions: FindingDisposition[];
  datasets: AssessedDatasetDto[];
}) {
  const [severity, setSeverity] = useState<FindingSeverity | 'ALL'>('ALL');
  const [category, setCategory] = useState<FindingCategory | 'ALL'>('ALL');
  const [dataset, setDataset] = useState('ALL');
  const [search, setSearch] = useState('');
  const [decided, setDecided] = useState<'ALL' | 'OPEN'>('ALL');
  const byFinding = useMemo(() => new Map(dispositions.map((d) => [d.findingId, d])), [dispositions]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return findings.filter((f) => {
      if (severity !== 'ALL' && f.severity !== severity) return false;
      if (category !== 'ALL' && f.category !== category) return false;
      if (dataset !== 'ALL' && f.dataset !== dataset) return false;
      // "What is still open" is the question somebody working through a list actually has.
      if (decided === 'OPEN' && (byFinding.get(f.id)?.status ?? 'OPEN') !== 'OPEN') return false;
      if (!needle) return true;
      return `${f.title} ${f.summary} ${f.table} ${f.columns.join(' ')}`.toLowerCase().includes(needle);
    });
  }, [findings, severity, category, dataset, search, decided, byFinding]);

  /** Only the categories actually present, because a filter offering nine empty options is noise. */
  const presentCategories = FINDING_CATEGORIES.filter((c) => findings.some((f) => f.category === c));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        {/* Severity as counts you can click, which is both the filter and the summary. */}
        <div className="flex gap-1.5">
          <FilterPill active={severity === 'ALL'} onClick={() => setSeverity('ALL')}>
            All {findings.length}
          </FilterPill>
          {SEVERITIES.map((s) => {
            const n = findings.filter((f) => f.severity === s).length;
            if (n === 0) return null;
            return (
              <FilterPill key={s} active={severity === s} onClick={() => setSeverity(s)}>
                <SeverityChip severity={s} />
                <span className="ml-1 tabular-nums">{n}</span>
              </FilterPill>
            );
          })}
        </div>
        <FilterPill
          active={decided === 'OPEN'}
          onClick={() => setDecided(decided === 'OPEN' ? 'ALL' : 'OPEN')}
        >
          Undecided only
        </FilterPill>
        <div className="ml-auto flex flex-wrap items-end gap-3">
          {datasets.length > 1 && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">Dataset</span>
              <Select
                label="Dataset"
                value={dataset}
                onChange={setDataset}
                options={[
                  { value: 'ALL', label: 'All datasets' },
                  ...datasets.map((d) => ({ value: d.name, label: d.name })),
                ]}
              />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Category</span>
            <Select
              label="Category"
              value={category}
              onChange={(v) => setCategory(v as FindingCategory | 'ALL')}
              options={[
                { value: 'ALL', label: 'All categories' },
                ...presentCategories.map((c) => ({ value: c, label: FINDING_CATEGORY_LABELS[c] })),
              ]}
            />
          </label>
          <label className="relative block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Search</span>
            <Search
              className="pointer-events-none absolute bottom-2.5 left-2.5 h-4 w-4 text-slate-400"
              aria-hidden
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Column or table"
              className="w-52 rounded-md border border-slate-300 py-1.5 pl-8 pr-2.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </label>
        </div>
      </div>

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Table2 className="h-8 w-8" />}
            title="Nothing matches those filters"
            description={`There are ${findings.length} findings in this project. Clear a filter to see them.`}
            action={
              <Button
                onClick={() => {
                  setSeverity('ALL');
                  setCategory('ALL');
                  setDataset('ALL');
                  setSearch('');
                }}
              >
                Clear filters
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {visible.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              projectId={projectId}
              disposition={byFinding.get(finding.id) ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'border-brand-600 bg-brand-50 text-brand-800'
          : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  );
}
