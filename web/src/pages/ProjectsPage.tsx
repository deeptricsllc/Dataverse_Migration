import { DemoWorkspaceBuilding } from '../components/DemoWorkspaceBuilding';
import {
  PROJECT_KIND_DESCRIPTIONS,
  PROJECT_KIND_LABELS,
  PROJECT_KINDS,
  type EnvironmentDto,
  type ProjectDto,
  type ProjectKind,
} from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FolderPlus, Microscope, Scale, Truck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ConnectionModal } from '../components/ConnectionForm';
import { WorkflowChooser } from '../components/WorkflowChooser';
import { get, post } from '../lib/api';
import { fmtNumber, fmtRelative } from '../lib/format';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  Field,
  ErrorState,
  Modal,
  PageHeader,
  Pill,
  Select,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../components/ui';

/**
 * Projects: where a piece of work lives.
 *
 * The first question is which kind, because the answer changes everything after it. An analysis
 * project reads a source and has nowhere to write; a migration project writes and carries every
 * safety gate; a comparison project reads two systems and writes to neither. The form asks that
 * first and then only asks for what that kind actually needs.
 */
/**
 * Where a project opens.
 *
 * An analysis project has its own workspace — datasets, findings, readiness — because it is a different
 * experience rather than a project page with a flag on it. The other two kinds keep the page they had.
 */
const projectHref = (p: { id: string; kind: string }) =>
  p.kind === 'ANALYSIS' ? `/analysis/${p.id}` : `/projects/${p.id}`;

export function ProjectsPage() {
  /**
   * `?new=1` opens the form on arrival, so a "New project" button elsewhere lands on the form rather
   * than on the list with the form still to find. It is a URL rather than router state because it
   * survives a reload and can be linked to.
   */
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1');
  const closeForm = () => {
    setCreating(false);
    if (params.get('new')) {
      const next = new URLSearchParams(params);
      next.delete('new');
      setParams(next, { replace: true });
    }
  };
  const [showArchived, setShowArchived] = useState(false);
  const projects = useQuery({
    queryKey: ['projects', showArchived],
    queryFn: () => get<ProjectDto[]>(`/api/projects${showArchived ? '?includeArchived=true' : ''}`),
  });

  const analysis = (projects.data ?? []).filter((p) => p.kind === 'ANALYSIS');
  const migration = (projects.data ?? []).filter((p) => p.kind === 'MIGRATION');
  const comparison = (projects.data ?? []).filter((p) => p.kind === 'COMPARISON');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Analysis projects hold datasets. Migration and comparison projects hold a source and a target."
        actions={
          <div className="flex items-center gap-3">
            <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />
            <Button
              variant="primary"
              icon={<FolderPlus className="h-4 w-4" />}
              data-testid="new-project"
              onClick={() => setCreating(true)}
            >
              New project
            </Button>
          </div>
        }
      />

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Start something new</h2>
        <WorkflowChooser compact />
      </section>

      <DemoWorkspaceBuilding onReady={() => void projects.refetch()} />

      {projects.isLoading && <Spinner label="Loading projects…" />}
      {projects.error && <ErrorState error={projects.error} onRetry={() => projects.refetch()} />}

      {projects.data && projects.data.length === 0 && (
        <EmptyState
          icon={<Microscope className="h-6 w-6" />}
          title="No projects yet"
          description="Create an analysis project to inspect a source. Create a migration project to move data."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              New project
            </Button>
          }
        />
      )}

      {analysis.length > 0 && (
        <ProjectTable
          title="Data analysis"
          subtitle="Read-only. Nothing in an analysis project can write to a source."
          icon={<Microscope className="h-4 w-4 text-violet-600" />}
          projects={analysis}
          countLabel="analyses"
        />
      )}
      {migration.length > 0 && (
        <ProjectTable
          title="Data migration"
          subtitle="Loads, transforms and writes into a target, with the full preflight and validation path."
          icon={<Truck className="h-4 w-4 text-blue-600" />}
          projects={migration}
          countLabel="plans"
        />
      )}
      {comparison.length > 0 && (
        <ProjectTable
          title="Comparison & validation"
          subtitle="Reconciles two datasets record by record: what matches, what differs, what is on one side only. Read-only on both sides."
          icon={<Scale className="h-4 w-4 text-amber-600" />}
          projects={comparison}
          countLabel="comparisons"
        />
      )}

      <NewProjectModal open={creating} onClose={closeForm} />
    </div>
  );
}

function ProjectTable({
  title,
  subtitle,
  icon,
  projects,
  countLabel,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  projects: ProjectDto[];
  countLabel: string;
}) {
  return (
    <Card title={title} subtitle={subtitle} actions={icon} data-testid={`projects-${countLabel}`}>
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Source</Th>
            <Th>Target</Th>
            <Th>Based on</Th>
            <Th className="text-right">{countLabel}</Th>
            <Th>Status</Th>
            <Th>Updated</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} className="hover:bg-slate-50">
              <Td>
                <Link to={projectHref(p)} className="font-medium text-brand-700 hover:underline">
                  {p.name}
                </Link>
                {p.description && <div className="text-xs text-slate-500">{p.description}</div>}
              </Td>
              <Td className="text-xs">{p.sourceEnvironment?.displayName ?? '—'}</Td>
              <Td className="text-xs">{p.targetEnvironment?.displayName ?? '—'}</Td>
              <Td className="text-xs">
                {p.analysisProject ? (
                  <Link to={`/projects/${p.analysisProject.id}`} className="text-brand-700 hover:underline">
                    {p.analysisProject.name}
                  </Link>
                ) : (
                  '—'
                )}
              </Td>
              <Td className="text-right tabular-nums">{fmtNumber(p.itemCount)}</Td>
              <Td>
                <StatusBadge status={p.status} />
              </Td>
              <Td className="text-xs text-slate-500">{fmtRelative(p.updatedAt)}</Td>
              <Td>
                <Link to={projectHref(p)} aria-label={`Open ${p.name}`}>
                  <ArrowRight className="h-4 w-4 text-slate-400" />
                </Link>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

/**
 * What the two connection pickers mean, per kind.
 *
 * They used to be two unlabelled "Choose…" boxes, because `Select` puts its label in `aria-label`
 * and nothing else. Which one was the source and which the target was guesswork.
 */
const SIDES: Record<
  ProjectKind,
  { source: string; sourceHint: string; target?: string; targetHint?: string }
> = {
  ANALYSIS: {
    source: 'Source',
    sourceHint: 'The system this project reads. It is never written to.',
  },
  MIGRATION: {
    source: 'Source',
    sourceHint: 'Where the data is read from.',
    target: 'Target',
    targetHint: 'Where the data will be written. You confirm this again before anything runs.',
  },
  COMPARISON: {
    source: 'Side A',
    sourceHint: 'The first of the two datasets to reconcile. Read only.',
    target: 'Side B',
    targetHint: 'The second. It may be the same connection as side A.',
  },
};

/** The kind is chosen first, because it decides which of the remaining questions are even asked. */
function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [kind, setKind] = useState<ProjectKind>('ANALYSIS');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [analysisProjectId, setAnalysisProjectId] = useState('');
  /**
   * Which picker asked for a new connection, or null.
   *
   * Adding one used to mean leaving for the connections page, which threw away whatever had been
   * typed here. The dialog opens over this form instead, and what it creates is selected in the
   * picker that asked for it.
   */
  const [addingFor, setAddingFor] = useState<'source' | 'target' | null>(null);

  const environments = useQuery({
    queryKey: ['environments'],
    queryFn: () => get<EnvironmentDto[]>('/api/environments'),
    enabled: open,
  });
  const analysisProjects = useQuery({
    queryKey: ['projects', 'ANALYSIS'],
    queryFn: () => get<ProjectDto[]>('/api/projects?kind=ANALYSIS'),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () =>
      post<ProjectDto>('/api/projects', {
        name,
        kind,
        description: description || null,
        sourceEnvironmentId: sourceId || null,
        targetEnvironmentId: kind !== 'ANALYSIS' && targetId ? targetId : null,
        analysisProjectId: kind === 'MIGRATION' && analysisProjectId ? analysisProjectId : null,
      }),
    onSuccess: (project) => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      onClose();
      /**
       * The older form still lands on the project page, which is where the controls for adding data and
       * running an analysis currently live. The new analysis workspace reads results; it does not yet
       * produce them, so sending this form there would be a dead end.
       */
      navigate(`/projects/${project.id}`);
    },
  });

  const connected = (environments.data ?? []).filter((e) => e.connectionStatus !== 'FAILED');
  const envOptions = [
    {
      value: '',
      label: connected.length ? 'Choose a connection…' : 'No connections yet. Add one first',
    },
    ...connected.map((e) => ({ value: e.id, label: e.displayName })),
  ];
  /*
   * A migration needs only a name here.
   *
   * Its two ends are properties of the migration and are chosen inside it, in context, where the
   * consequences of changing one can be explained. Demanding them on the creation form is what sent
   * people to the Connections page before they had made anything — and a half-filled form they abandoned
   * to go and create a connection was the most common way to lose the name they had just typed.
   */
  /*
   * An analysis project needs a name. It does not need a connection yet.
   *
   * It used to require one, and the list of connections includes ones that are not datasets — a
   * SharePoint connection nobody has chosen a file from is reusable access to a system, not data.
   * Requiring a choice from that list is how somebody picked an empty connection, created the
   * project around it, and met `None of the requested tables exist in this source` when they
   * pressed Analyze.
   *
   * Datasets are added in the workspace, where choosing a sheet, a table or a list is the whole
   * interaction and cannot be skipped. The shortcut on this same page already created analysis
   * projects with no source; the long form now agrees with it.
   */
  const ready =
    kind === 'MIGRATION' || kind === 'ANALYSIS'
      ? Boolean(name.trim())
      : Boolean(
          name.trim() &&
          sourceId &&
          targetId &&
          // A comparison may point both sides at one connection: comparing two tables inside a single
          // database is an ordinary thing to want, and nothing it does writes.
          (kind === 'COMPARISON' || sourceId !== targetId),
        );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={create.isPending}
            data-testid="create-project"
            onClick={() => create.mutate()}
          >
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="project-kind">
            What is this project for?
          </label>
          <select
            id="project-kind"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            value={kind}
            data-testid="project-kind"
            onChange={(e) => setKind(e.target.value as ProjectKind)}
          >
            {PROJECT_KINDS.map((k) => (
              <option key={k} value={k}>
                {PROJECT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-slate-500">{PROJECT_KIND_DESCRIPTIONS[kind]}</p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="project-name">
            Name
          </label>
          <input
            id="project-name"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            value={name}
            data-testid="project-name"
            placeholder={
              kind === 'ANALYSIS'
                ? 'Understand the legacy CRM'
                : kind === 'COMPARISON'
                  ? 'Monthly reconciliation: CRM against the warehouse'
                  : 'Legacy CRM into Dataverse'
            }
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="project-description">
            Description <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            id="project-description"
            rows={2}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {environments.isLoading && <Spinner label="Loading connections…" />}
        {environments.data && connected.length === 0 && (
          <Callout tone="warning" title="No connections yet">
            A project works on a system it can reach, so add one first: a Dataverse environment, a SQL Server,
            Azure SQL, PostgreSQL or MySQL database, or a CSV, Excel or XML file to upload. Use{' '}
            <strong>Add a connection</strong> below. It opens here and keeps what you have typed.
          </Callout>
        )}

        <Field
          label={SIDES[kind].source}
          htmlFor="project-source"
          hint={SIDES[kind].sourceHint}
          action={
            <button
              type="button"
              className="text-xs font-medium text-brand-700 hover:underline"
              data-testid="add-connection-link"
              onClick={() => setAddingFor('source')}
            >
              Add a connection
            </button>
          }
        >
          <Select
            id="project-source"
            label={SIDES[kind].source}
            value={sourceId}
            onChange={setSourceId}
            options={envOptions}
            className="w-full"
          />
          {kind === 'ANALYSIS' && (
            <p className="mt-1 text-xs text-slate-500">
              Optional. You choose the sheets, tables or lists to analyze in the project itself.
            </p>
          )}
        </Field>
        {kind === 'COMPARISON' && (
          <>
            <Field
              label={SIDES[kind].target!}
              htmlFor="project-target"
              hint={SIDES[kind].targetHint}
              action={
                <button
                  type="button"
                  className="text-xs font-medium text-brand-700 hover:underline"
                  data-testid="add-connection-link-target"
                  onClick={() => setAddingFor('target')}
                >
                  Add a connection
                </button>
              }
            >
              <Select
                id="project-target"
                label={SIDES[kind].target!}
                value={targetId}
                onChange={setTargetId}
                options={envOptions}
                className="w-full"
              />
            </Field>
            <p className="flex items-start gap-2 text-xs text-slate-500">
              <Pill tone="teal">read-only</Pill>
              <span>
                Both sides are only ever read. They may be the same connection: comparing a staging table
                against the live one inside a single database is a comparison too.
              </span>
            </p>
          </>
        )}
        {kind === 'MIGRATION' && (
          <>
            <Field
              label={SIDES[kind].target!}
              htmlFor="project-target"
              hint={SIDES[kind].targetHint}
              action={
                <button
                  type="button"
                  className="text-xs font-medium text-brand-700 hover:underline"
                  data-testid="add-connection-link-target"
                  onClick={() => setAddingFor('target')}
                >
                  Add a connection
                </button>
              }
            >
              <Select
                id="project-target"
                label={SIDES[kind].target!}
                value={targetId}
                onChange={setTargetId}
                options={envOptions}
                className="w-full"
              />
            </Field>
            {sourceId && sourceId === targetId && (
              <p className="text-xs text-red-600">The source and target have to be different.</p>
            )}
            <Field
              label="Based on analysis"
              htmlFor="project-analysis"
              optional
              hint="Start from an analysis project, and the mapping workbook carries the statistics and findings it measured instead of blank columns."
            >
              <Select
                id="project-analysis"
                label="Based on analysis"
                value={analysisProjectId}
                onChange={setAnalysisProjectId}
                options={[
                  {
                    value: '',
                    label: analysisProjects.data?.length ? 'None' : 'None. No analysis projects yet',
                  },
                  ...(analysisProjects.data ?? []).map((p) => ({ value: p.id, label: p.name })),
                ]}
                className="w-full"
              />
            </Field>
          </>
        )}
        {kind === 'ANALYSIS' && (
          <p className="flex items-center gap-2 text-xs text-slate-500">
            <Pill tone="teal">read-only</Pill>
            An analysis project has no target. Nothing it does can write anywhere.
          </p>
        )}
        {create.error && <ErrorState error={create.error} />}
      </div>

      {/*
        Opened over this form rather than instead of it, so nothing typed here is lost. What the
        dialog creates is selected in the picker that asked for it.
      */}
      {addingFor && (
        <ConnectionModal
          connection={null}
          discovering={false}
          onClose={() => setAddingFor(null)}
          onDiscover={() => {}}
          onSaved={(saved) => {
            if (addingFor === 'source') setSourceId(saved.id);
            else setTargetId(saved.id);
            setAddingFor(null);
            void qc.invalidateQueries({ queryKey: ['environments'] });
            // A file source holds nothing until a file is in it, so ask for one now rather than
            // letting the project be created against an empty source.
          }}
        />
      )}
    </Modal>
  );
}
