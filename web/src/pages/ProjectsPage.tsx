import {
  PROJECT_KIND_DESCRIPTIONS,
  PROJECT_KIND_LABELS,
  PROJECT_KINDS,
  type EnvironmentDto,
  type ProjectDto,
  type ProjectKind,
} from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FolderPlus, Microscope, Truck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api';
import { fmtNumber, fmtRelative } from '../lib/format';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
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
 * safety gate. The form asks that first and then only asks for what that kind actually needs.
 */
export function ProjectsPage() {
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const projects = useQuery({
    queryKey: ['projects', showArchived],
    queryFn: () => get<ProjectDto[]>(`/api/projects${showArchived ? '?includeArchived=true' : ''}`),
  });

  const analysis = (projects.data ?? []).filter((p) => p.kind === 'ANALYSIS');
  const migration = (projects.data ?? []).filter((p) => p.kind === 'MIGRATION');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Analyse a source to understand it, or migrate data into a target. A migration can start from an analysis."
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

      {projects.isLoading && <Spinner label="Loading projects…" />}
      {projects.error && <ErrorState error={projects.error} onRetry={() => projects.refetch()} />}

      {projects.data && projects.data.length === 0 && (
        <EmptyState
          icon={<Microscope className="h-6 w-6" />}
          title="No projects yet"
          description="Start with an analysis project to find out what is in a source system, then create a migration project that uses it."
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

      <NewProjectModal open={creating} onClose={() => setCreating(false)} />
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
                <Link to={`/projects/${p.id}`} className="font-medium text-brand-700 hover:underline">
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
                <Link to={`/projects/${p.id}`} aria-label={`Open ${p.name}`}>
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
        targetEnvironmentId: kind === 'MIGRATION' && targetId ? targetId : null,
        analysisProjectId: kind === 'MIGRATION' && analysisProjectId ? analysisProjectId : null,
      }),
    onSuccess: (project) => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      onClose();
      navigate(`/projects/${project.id}`);
    },
  });

  const connected = (environments.data ?? []).filter((e) => e.connectionStatus !== 'FAILED');
  const envOptions = [
    { value: '', label: 'Choose…' },
    ...connected.map((e) => ({ value: e.id, label: e.displayName })),
  ];
  const ready = name.trim() && sourceId && (kind === 'ANALYSIS' || targetId) && sourceId !== targetId;

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
            placeholder={kind === 'ANALYSIS' ? 'Understand the legacy CRM' : 'Legacy CRM into Dataverse'}
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
            Add a connection first — a project analyses or migrates a system it can reach.
          </Callout>
        )}

        <Select
          label="Source"
          value={sourceId}
          onChange={setSourceId}
          options={envOptions}
          className="w-full"
        />
        {kind === 'MIGRATION' && (
          <>
            <Select
              label="Target"
              value={targetId}
              onChange={setTargetId}
              options={envOptions}
              className="w-full"
            />
            {sourceId && sourceId === targetId && (
              <p className="text-xs text-red-600">The source and target have to be different.</p>
            )}
            <div>
              <Select
                label="Based on analysis"
                value={analysisProjectId}
                onChange={setAnalysisProjectId}
                options={[
                  { value: '', label: 'None' },
                  ...(analysisProjects.data ?? []).map((p) => ({ value: p.id, label: p.name })),
                ]}
                className="w-full"
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Optional. The mapping workbook then carries the source statistics and findings that analysis
                measured, instead of blank columns.
              </p>
            </div>
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
    </Modal>
  );
}
