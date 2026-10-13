import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, GitCompareArrows, Microscope, Truck } from 'lucide-react';
import type { ProjectDto, ProjectKind } from '@shared/domain';
import { Button, Callout, ErrorState, Field, Modal, cx } from './ui';
import { api } from '../lib/api';

/**
 * The first decision, made obvious.
 *
 * Three workflows, each described by the question it answers rather than by the features it contains —
 * because somebody opening this product for the first time does not yet know what a preflight is, and
 * naming one does not help them choose. They know whether they are trying to understand data, move it, or
 * prove it arrived.
 *
 * They are also genuinely different experiences, which is why this is a choice rather than a dropdown on a
 * generic form. Analysis has datasets and no target; migration has a source and a target; a comparison has
 * two sides and writes to neither. Collapsing them into one form was what made every analysis project ask
 * where the data was going.
 */

interface Workflow {
  kind: ProjectKind;
  name: string;
  question: string;
  blurb: string;
  examples: string[];
  icon: typeof Microscope;
  accent: string;
  /** Analysis needs only a name. The other two need sides, which they collect on their own screens. */
  createsImmediately: boolean;
}

const WORKFLOWS: Workflow[] = [
  {
    kind: 'ANALYSIS',
    name: 'Analyze',
    question: 'What is in my data, and what should I know about it?',
    blurb:
      'Profile one dataset or several together. Find the problems that would break a migration before you plan one.',
    examples: [
      'Duplicates and missing identifiers',
      'Empty and sparse columns',
      'Dates stored as numbers',
      'Candidate business keys',
      'Migration readiness',
    ],
    icon: Microscope,
    accent: 'text-brand-600',
    createsImmediately: true,
  },
  {
    kind: 'MIGRATION',
    name: 'Migrate',
    question: 'How do I safely move data from one system to another?',
    blurb:
      'Map fields, transform values, order dependencies, see exactly what will change, then run it and reconcile.',
    examples: [
      'Schema comparison',
      'Field mapping and transformation',
      'Dependency ordering',
      'Preflight: every record classified',
      'Reconciliation and audit',
    ],
    icon: Truck,
    accent: 'text-violet-600',
    createsImmediately: false,
  },
  {
    kind: 'COMPARISON',
    name: 'Validate',
    question: 'Did these two systems end up agreeing?',
    blurb:
      'Compare two datasets record by record. See what is missing, what is extra, and exactly which fields differ.',
    examples: [
      'Record counts',
      'Field-level differences',
      'Missing and unexpected records',
      'Exportable discrepancies',
    ],
    icon: GitCompareArrows,
    accent: 'text-emerald-600',
    createsImmediately: false,
  },
];

export function WorkflowChooser({ compact = false }: { compact?: boolean }) {
  const [chosen, setChosen] = useState<Workflow | null>(null);
  return (
    <>
      <div className={cx('grid gap-4', compact ? 'md:grid-cols-3' : 'lg:grid-cols-3')}>
        {WORKFLOWS.map((workflow) => {
          const Icon = workflow.icon;
          return (
            <button
              key={workflow.kind}
              type="button"
              data-testid={`workflow-${workflow.kind}`}
              onClick={() => setChosen(workflow)}
              className="group flex h-full flex-col rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-all hover:border-brand-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Icon className={cx('h-6 w-6', workflow.accent)} aria-hidden />
              <h3 className="mt-3 text-base font-semibold text-slate-900">{workflow.name}</h3>
              {/* The question, which is how somebody recognises their own situation. */}
              <p className="mt-1 text-sm font-medium text-slate-700">{workflow.question}</p>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">{workflow.blurb}</p>
              {!compact && (
                <ul className="mt-3 space-y-1 text-xs text-slate-500">
                  {workflow.examples.map((example) => (
                    <li key={example} className="flex gap-1.5">
                      <span className="text-slate-300" aria-hidden>
                        •
                      </span>
                      {example}
                    </li>
                  ))}
                </ul>
              )}
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand-700">
                Start
                <ArrowRight
                  className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                  aria-hidden
                />
              </span>
            </button>
          );
        })}
      </div>
      <NewProjectModal workflow={chosen} onClose={() => setChosen(null)} />
    </>
  );
}

/**
 * Asks for the name, and nothing else.
 *
 * An analysis project needs a name to exist; the datasets come afterwards, inside it. Asking for a source
 * and a target up front was the thing that made the three workflows feel like one form with a label on it,
 * and it asked migration questions of somebody who had not decided to migrate anything.
 */
function NewProjectModal({ workflow, onClose }: { workflow: Workflow | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api<ProjectDto>('POST', '/api/projects', {
        name: name.trim(),
        kind: workflow!.kind,
        description: description.trim() || null,
      }),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      onClose();
      setName('');
      setDescription('');
      navigate(project.kind === 'ANALYSIS' ? `/analysis/${project.id}` : `/projects/${project.id}`);
    },
  });

  if (!workflow) return null;
  const Icon = workflow.icon;

  return (
    <Modal open onClose={onClose} title={`New ${workflow.name.toLowerCase()} project`}>
      <div className="space-y-4">
        <div className="flex gap-3 rounded-lg bg-slate-50 p-3.5">
          <Icon className={cx('mt-0.5 h-5 w-5 flex-none', workflow.accent)} aria-hidden />
          <p className="text-sm leading-relaxed text-slate-600">{workflow.blurb}</p>
        </div>

        <Field
          label="Project name"
          htmlFor="new-project-name"
          hint="Shown everywhere this work is referred to, so it has to be unique in your workspace."
        >
          <input
            id="new-project-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) create.mutate();
            }}
            placeholder={workflow.kind === 'ANALYSIS' ? 'Customer Data Assessment' : 'Legacy CRM Migration'}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </Field>

        <Field label="Description" htmlFor="new-project-description" optional>
          <textarea
            id="new-project-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </Field>

        {workflow.createsImmediately ? (
          <Callout tone="info" title="You choose the data next">
            Nothing is written anywhere by an analysis. Add as many datasets as the question needs.
          </Callout>
        ) : (
          <Callout tone="info" title="You choose the two sides next">
            {workflow.kind === 'MIGRATION'
              ? 'A migration moves data from one system to another, so it needs both, and they cannot be the same one.'
              : 'A comparison needs the two datasets you want to compare.'}
          </Callout>
        )}

        {create.error && <ErrorState error={create.error} />}

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create project
          </Button>
        </div>
      </div>
    </Modal>
  );
}
