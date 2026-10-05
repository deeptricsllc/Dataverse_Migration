import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Database, FileSpreadsheet, Plus, Search, Table2 } from 'lucide-react';
import type { AnalysisAssessmentDto, AssessedDatasetDto, ProjectDto } from '@shared/domain';
import type { Finding, FindingSeverity } from '@shared/findings';
import { FINDING_CATEGORIES, FINDING_CATEGORY_LABELS, type FindingCategory } from '@shared/findings';
import { FindingCard, SeverityChip } from '../components/FindingCard';
import { ReadinessPanel } from '../components/ReadinessPanel';
import {
  Button,
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

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDto>('GET', `/api/projects/${projectId}`),
  });
  const assessment = useQuery({
    queryKey: ['assessment', projectId],
    queryFn: () => api<AnalysisAssessmentDto>('GET', `/api/projects/${projectId}/assessment`),
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
          /*
           * Onward to the project page, which is where the controls for adding data and running an
           * analysis currently live. This workspace reads results; it does not yet produce them, and a
           * button that quietly does nothing is worse than one that goes somewhere.
           */
          <Link to={`/projects/${projectId}`}>
            <Button variant="secondary" icon={<Plus className="h-4 w-4" />}>
              Add dataset
            </Button>
          </Link>
        }
      />

      {/* The scale of what was looked at, in the words a person would use. */}
      <p className="-mt-3 mb-5 text-sm text-slate-500">
        {data.datasets.length === 0
          ? 'No datasets yet.'
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
        <Overview data={data} projectId={projectId} onSeeAll={() => setSection('findings')} />
      )}
      {section === 'datasets' && <Datasets datasets={data.datasets} projectId={projectId} />}
      {section === 'findings' && <FindingsWorkspace findings={data.findings} datasets={data.datasets} />}
    </div>
  );
}

const describeCount = (n: number, noun: string) => `${n.toLocaleString()} ${n === 1 ? noun : `${noun}s`}`;

// ---------------------------------------------------------------------------

function Overview({
  data,
  projectId,
  onSeeAll,
}: {
  data: AnalysisAssessmentDto;
  projectId: string;
  onSeeAll: () => void;
}) {
  if (data.datasets.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Database className="h-8 w-8" />}
          title="Add the data you want to understand"
          description="A spreadsheet, a CSV export, a database or a Dataverse environment. You can add several — this project is about all of them together, and nothing is written anywhere."
          action={
            <Link to={`/projects/${projectId}`}>
              <Button variant="primary">Add dataset</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  /** The findings worth leading with: everything critical, then warnings, capped so the page stays readable. */
  const top = data.findings.filter((f) => f.severity !== 'INFO').slice(0, 5);

  return (
    <div className="space-y-5">
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

function Datasets({ datasets, projectId }: { datasets: AssessedDatasetDto[]; projectId: string }) {
  if (datasets.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Database className="h-8 w-8" />}
          title="No datasets in this project"
          description="Add a spreadsheet, a database or a Dataverse environment. Adding one here does not copy it — the connection stays available to your other projects."
          action={
            <Link to={`/projects/${projectId}`}>
              <Button variant="primary">Add dataset</Button>
            </Link>
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
            {dataset.analysed ? (
              <div className="flex items-center gap-4 text-sm">
                {dataset.critical > 0 && (
                  <span className="font-semibold text-red-700">{dataset.critical} critical</span>
                )}
                {dataset.warning > 0 && (
                  <span className="font-semibold text-amber-800">{dataset.warning} warnings</span>
                )}
                {dataset.critical === 0 && dataset.warning === 0 && (
                  <span className="text-emerald-700">No problems found</span>
                )}
              </div>
            ) : (
              <Link to={`/projects/${projectId}`}>
                <Button size="sm" variant="primary">
                  Analyse
                </Button>
              </Link>
            )}
          </div>
        </Card>
      ))}
    </div>
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

function FindingsWorkspace({ findings, datasets }: { findings: Finding[]; datasets: AssessedDatasetDto[] }) {
  const [severity, setSeverity] = useState<FindingSeverity | 'ALL'>('ALL');
  const [category, setCategory] = useState<FindingCategory | 'ALL'>('ALL');
  const [dataset, setDataset] = useState('ALL');
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return findings.filter((f) => {
      if (severity !== 'ALL' && f.severity !== severity) return false;
      if (category !== 'ALL' && f.category !== category) return false;
      if (dataset !== 'ALL' && f.dataset !== dataset) return false;
      if (!needle) return true;
      return `${f.title} ${f.summary} ${f.table} ${f.columns.join(' ')}`.toLowerCase().includes(needle);
    });
  }, [findings, severity, category, dataset, search]);

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
            <FindingCard key={finding.id} finding={finding} />
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
