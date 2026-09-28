import type {
  ComparisonFieldPairDto,
  ComparisonSuggestionDto,
  DataComparisonDto,
  DataComparisonListItemDto,
  ProjectDto,
} from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Play, Scale } from 'lucide-react';
import { useEffect, useState } from 'react';
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
  Pill,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from './ui';

/** How often to re-check a running comparison. */
const POLL_MS = 2000;

/**
 * A comparison project: the reconciliation runs it holds, and the screen that sets one up.
 *
 * The setup is a confirmation, not data entry. The server proposes which tables pair with which,
 * what identifies a record on each side, and which columns are worth comparing; this screen shows
 * that and lets a person disagree with any of it. Nothing proposed runs without being confirmed.
 */
export function ComparisonProject({ project }: { project: ProjectDto }) {
  const [starting, setStarting] = useState(false);
  const comparisons = useQuery({
    queryKey: ['data-comparisons', project.id],
    queryFn: () => get<DataComparisonListItemDto[]>(`/api/projects/${project.id}/data-comparisons`),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((c) => c.status === 'QUEUED' || c.status === 'RUNNING') ? POLL_MS : false,
  });

  const ready = Boolean(project.sourceEnvironment && project.targetEnvironment);

  return (
    <div className="space-y-5">
      {!ready && (
        <Callout tone="warning" title="This comparison needs both sides">
          Choose the two systems to compare on the Connections page. Both are only ever read.
        </Callout>
      )}

      <Card
        title="Comparisons"
        subtitle="Each run is a point-in-time reconciliation. Run it as often as you need — nothing is overwritten and nothing is written to either side."
        data-testid="comparisons"
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Play className="h-3.5 w-3.5" />}
            disabled={!ready}
            data-testid="new-comparison"
            onClick={() => setStarting(true)}
          >
            New comparison
          </Button>
        }
      >
        {comparisons.isLoading && <Spinner label="Loading comparisons…" />}
        {comparisons.error && <ErrorState error={comparisons.error} />}
        {comparisons.data?.length === 0 && (
          <EmptyState
            icon={<Scale className="h-6 w-6" />}
            title="Nothing compared yet"
            description="A comparison matches records on a key you choose, then reports what agrees, what differs field by field, and what exists on only one side."
            action={
              <Button variant="primary" disabled={!ready} onClick={() => setStarting(true)}>
                New comparison
              </Button>
            }
          />
        )}
        {(comparisons.data?.length ?? 0) > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Comparison</Th>
                <Th>Status</Th>
                <Th className="text-right">Matched</Th>
                <Th className="text-right">Different</Th>
                <Th className="text-right">Only on A</Th>
                <Th className="text-right">Only on B</Th>
                <Th>Run</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {comparisons.data!.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <Td>
                    <Link
                      to={`/data-comparisons/${c.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {c.name}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {c.tableCount} table{c.tableCount === 1 ? '' : 's'}
                    </div>
                  </Td>
                  <Td>
                    <StatusBadge status={c.status === 'COMPLETED' ? c.outcome : c.status} />
                  </Td>
                  <Td className="text-right tabular-nums text-emerald-700">{fmtNumber(c.totals.matched)}</Td>
                  <Td className="text-right tabular-nums">
                    {c.totals.different > 0 ? (
                      <span className="font-medium text-red-700">{fmtNumber(c.totals.different)}</span>
                    ) : (
                      '0'
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">{fmtNumber(c.totals.onlyInLeft)}</Td>
                  <Td className="text-right tabular-nums">{fmtNumber(c.totals.onlyInRight)}</Td>
                  <Td className="text-xs text-slate-500">{fmtRelative(c.createdAt)}</Td>
                  <Td>
                    <Link to={`/data-comparisons/${c.id}`} aria-label={`Open ${c.name}`}>
                      <ArrowRight className="h-4 w-4 text-slate-400" />
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <NewComparisonModal project={project} open={starting} onClose={() => setStarting(false)} />
    </div>
  );
}

/** One row of the setup screen: a table pair, whether to compare it, and what identifies a record. */
interface PairChoice {
  selected: boolean;
  /** Index into the key options for this pair. */
  keyIndex: number;
  options: { key: ComparisonFieldPairDto; label: string; suggested: boolean }[];
}

function NewComparisonModal({
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
  const [compareValues, setCompareValues] = useState(true);
  const [choices, setChoices] = useState<Record<string, PairChoice>>({});

  const suggestions = useQuery({
    queryKey: ['comparison-suggestions', project.id],
    queryFn: () => get<ComparisonSuggestionDto[]>(`/api/projects/${project.id}/data-comparison-suggestions`),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!suggestions.data) return;
    const next: Record<string, PairChoice> = {};
    for (const s of suggestions.data) {
      // Every field pair is a candidate key, because the person looking at this screen knows which
      // column identifies a record and the server can only know which ones are provably unique.
      const options = [
        ...s.key.map((k) => ({ key: k, label: `${k.left} ↔ ${k.right}`, suggested: true })),
        ...s.fields
          .filter((f) => !s.key.some((k) => k.left === f.left))
          .map((f) => ({ key: f, label: `${f.left} ↔ ${f.right}`, suggested: false })),
      ];
      next[s.leftTable] = { selected: s.keyProposed, keyIndex: 0, options };
    }
    setChoices(next);
  }, [suggestions.data]);

  const create = useMutation({
    mutationFn: () => {
      const pairs = (suggestions.data ?? [])
        .filter((s) => choices[s.leftTable]?.selected && choices[s.leftTable].options.length)
        .map((s) => {
          const choice = choices[s.leftTable];
          const key = choice.options[choice.keyIndex].key;
          return {
            leftTable: s.leftTable,
            rightTable: s.rightTable,
            key: [key],
            // The key is never also compared as a value: it agrees by definition on every record
            // that paired, so including it would add a column of guaranteed matches.
            fields: compareValues ? s.fields.filter((f) => f.left !== key.left) : [],
          };
        });
      return post<DataComparisonDto>(`/api/projects/${project.id}/data-comparisons`, {
        name: name.trim() || undefined,
        pairs,
      });
    },
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: ['data-comparisons', project.id] });
      onClose();
      navigate(`/data-comparisons/${run.id}`);
    },
  });

  const chosen = Object.values(choices).filter((c) => c.selected).length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New comparison"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={chosen === 0}
            loading={create.isPending}
            data-testid="start-comparison"
            onClick={() => create.mutate()}
          >
            Compare {chosen > 0 ? `${chosen} table${chosen === 1 ? '' : 's'}` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="comparison-name">
            Name <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            id="comparison-name"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            value={name}
            data-testid="comparison-name"
            placeholder="September reconciliation"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
          <div className="flex items-center gap-2 font-medium text-slate-700">
            <Pill tone="teal">read-only</Pill>
            {project.sourceEnvironment?.displayName} ↔ {project.targetEnvironment?.displayName}
          </div>
          <p className="mt-1.5">
            Records are matched on the key you choose here, not on row order. A key that is not unique cannot
            identify a record, so those records are reported rather than compared.
          </p>
        </div>

        <Checkbox
          checked={compareValues}
          onChange={setCompareValues}
          label="Compare column values, not just which records exist"
        />

        {suggestions.isLoading && <Spinner label="Reading both catalogues…" />}
        {suggestions.error && <ErrorState error={suggestions.error} onRetry={() => suggestions.refetch()} />}
        {suggestions.data?.length === 0 && (
          <Callout tone="warning" title="No tables line up by name">
            Nothing on one side has a name resembling anything on the other, so there is nothing to propose.
            Comparing systems whose tables are named differently needs the mapping workbook.
          </Callout>
        )}

        {(suggestions.data?.length ?? 0) > 0 && (
          <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {suggestions.data!.map((s) => {
              const choice = choices[s.leftTable];
              if (!choice) return null;
              return (
                <div key={s.leftTable} className="rounded-lg border border-slate-200 p-3">
                  <Checkbox
                    checked={choice.selected}
                    onChange={(selected) =>
                      setChoices((c) => ({ ...c, [s.leftTable]: { ...choice, selected } }))
                    }
                    label={`${s.leftTable} ↔ ${s.rightTable}`}
                  />
                  <p className="mt-1 pl-6 text-xs text-slate-500">{s.rationale}</p>
                  {choice.selected && (
                    <div className="mt-2 flex items-center gap-2 pl-6">
                      <label className="text-xs text-slate-600" htmlFor={`key-${s.leftTable}`}>
                        Match records on
                      </label>
                      <select
                        id={`key-${s.leftTable}`}
                        className="rounded border border-slate-300 px-2 py-1 text-xs"
                        value={choice.keyIndex}
                        onChange={(e) =>
                          setChoices((c) => ({
                            ...c,
                            [s.leftTable]: { ...choice, keyIndex: Number(e.target.value) },
                          }))
                        }
                      >
                        {choice.options.map((o, i) => (
                          <option key={o.label} value={i}>
                            {o.label}
                            {o.suggested ? ' (unique)' : ''}
                          </option>
                        ))}
                      </select>
                      {!choice.options[choice.keyIndex]?.suggested && (
                        <Pill tone="amber" title="Nothing guarantees this column is unique">
                          not known to be unique
                        </Pill>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {create.error && <ErrorState error={create.error} />}
      </div>
    </Modal>
  );
}
