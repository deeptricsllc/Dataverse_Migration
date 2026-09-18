import type {
  FieldMappingDto,
  MigrationPlanDto,
  TransformationKind,
  TransformationRule,
  TransformationTemplateDto,
  TransformPreviewDto,
} from '@shared/domain';
import { LOSSY_TRANSFORMATIONS } from '@shared/domain';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Callout, ErrorState, Modal, Pill, Select, Spinner, Table, Td, Th } from './ui';
import { get, patch, post } from '../lib/api';

/** The rules offered in the editor, grouped the way a person thinks about them. */
const RULE_GROUPS: { label: string; kinds: TransformationKind[] }[] = [
  {
    label: 'Text',
    kinds: [
      'TRIM',
      'LEFT_TRIM',
      'RIGHT_TRIM',
      'UPPERCASE',
      'LOWERCASE',
      'REPLACE',
      'PREFIX',
      'SUFFIX',
      'SUBSTRING',
      'TRUNCATE',
    ],
  },
  {
    label: 'Empty values',
    kinds: [
      'EMPTY_TO_NULL',
      'NULL_TO_EMPTY',
      'DEFAULT_IF_NULL',
      'DEFAULT_IF_BLANK',
      'BLOCK_IF_NULL',
      'CONSTANT',
    ],
  },
  {
    label: 'Type',
    kinds: ['TO_STRING', 'TO_INTEGER', 'TO_DECIMAL', 'TO_BOOLEAN', 'TO_DATE', 'TO_DATETIME', 'TO_GUID'],
  },
  { label: 'Values', kinds: ['VALUE_MAP'] },
  { label: 'Composition', kinds: ['CONCAT'] },
];

const RULE_LABELS: Partial<Record<TransformationKind, string>> = {
  TRIM: 'Trim whitespace',
  LEFT_TRIM: 'Trim leading whitespace',
  RIGHT_TRIM: 'Trim trailing whitespace',
  UPPERCASE: 'Uppercase',
  LOWERCASE: 'Lowercase',
  REPLACE: 'Replace text',
  PREFIX: 'Add a prefix',
  SUFFIX: 'Add a suffix',
  SUBSTRING: 'Take part of the value',
  TRUNCATE: 'Truncate to a length',
  EMPTY_TO_NULL: 'Empty string → null',
  NULL_TO_EMPTY: 'Null → empty string',
  DEFAULT_IF_NULL: 'Default when null',
  DEFAULT_IF_BLANK: 'Default when blank',
  BLOCK_IF_NULL: 'Block when empty',
  CONSTANT: 'Always this value',
  TO_STRING: 'Convert to text',
  TO_INTEGER: 'Convert to whole number',
  TO_DECIMAL: 'Convert to decimal',
  TO_BOOLEAN: 'Convert to yes/no',
  TO_DATE: 'Convert to date',
  TO_DATETIME: 'Convert to date and time',
  TO_GUID: 'Convert to GUID',
  VALUE_MAP: 'Map values',
  CONCAT: 'Combine fields',
};

const DATE_FORMATS = [
  'YYYY-MM-DD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'MM-DD-YYYY',
  'DD-MM-YYYY',
  'DD.MM.YYYY',
  'YYYYMMDD',
];

/**
 * Configures the ordered transformation pipeline for one field mapping, with a preview that runs
 * the server's engine over real source values — the same engine the migration runs, so what the
 * preview shows is what will be written.
 */
export function TransformationEditor({
  plan,
  mapping,
  sourceFields,
  open,
  onClose,
  onPlan,
}: {
  plan: MigrationPlanDto;
  mapping: FieldMappingDto;
  sourceFields: { logicalName: string; displayName: string }[];
  open: boolean;
  onClose: () => void;
  onPlan: (p: MigrationPlanDto) => void;
}) {
  const [rules, setRules] = useState<TransformationRule[]>(mapping.transformations ?? []);
  const [adding, setAdding] = useState<TransformationKind | ''>('');

  const templates = useQuery({
    queryKey: ['transformation-templates'],
    queryFn: () => get<TransformationTemplateDto[]>('/api/transformation-templates'),
    enabled: open,
  });

  const preview = useMutation({
    mutationFn: (candidate: TransformationRule[]) =>
      post<TransformPreviewDto>(`/api/plans/${plan.id}/mappings/${mapping.id}/preview`, {
        rules: candidate,
      }),
  });
  // Preview whenever the pipeline changes: the point is to see the effect while editing.
  useEffect(() => {
    if (open) preview.mutate(rules);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules, open]);

  const save = useMutation({
    mutationFn: () =>
      patch<MigrationPlanDto>(`/api/plans/${plan.id}/mappings/${mapping.id}/transformations`, { rules }),
    onSuccess: (p) => {
      onPlan(p);
      onClose();
    },
  });

  const move = (index: number, delta: number) => {
    const next = [...rules];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setRules(next);
  };
  const update = (index: number, patchRule: Partial<TransformationRule>) =>
    setRules(rules.map((r, i) => (i === index ? { ...r, ...patchRule } : r)));

  const lossy = rules.some((r) => LOSSY_TRANSFORMATIONS.has(r.kind));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Transformations — ${mapping.sourceDisplayName} → ${mapping.targetField ?? '(unmapped)'}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => save.mutate()}
            data-testid="save-transformations"
          >
            Save pipeline
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">
          Rules run in order, before the value is converted into the target column's type. The source data is
          never modified: these rules are migration configuration.
        </p>

        {templates.data && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Templates</span>
            {templates.data.map((tpl) => (
              <Button
                key={tpl.id}
                size="sm"
                icon={<Wand2 className="h-3.5 w-3.5" />}
                title={tpl.description}
                onClick={() => setRules(tpl.rules)}
                data-testid={`template-${tpl.id}`}
              >
                {tpl.name}
              </Button>
            ))}
          </div>
        )}

        <ol className="space-y-2" data-testid="transformation-list">
          {rules.map((rule, index) => (
            <li
              key={`${rule.kind}-${index}`}
              className="rounded-md border border-slate-200 p-2"
              data-testid={`rule-${rule.kind}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-xs text-slate-400">{index + 1}.</span>
                <span className="font-medium text-slate-900">{RULE_LABELS[rule.kind] ?? rule.kind}</span>
                {LOSSY_TRANSFORMATIONS.has(rule.kind) && <Pill tone="amber">lossy</Pill>}
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => move(index, -1)} aria-label="Move up">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => move(index, 1)} aria-label="Move down">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${rule.kind}`}
                    onClick={() => setRules(rules.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </div>
              <RuleParameters rule={rule} sourceFields={sourceFields} onChange={(p) => update(index, p)} />
            </li>
          ))}
          {rules.length === 0 && (
            <li className="rounded-md border border-dashed border-slate-300 p-3 text-slate-500">
              No transformations: the value is copied as it is.
            </li>
          )}
        </ol>

        <div className="flex items-center gap-2">
          <Select
            label="Add a transformation"
            value={adding}
            onChange={(v) => setAdding(v as TransformationKind)}
            options={[
              { value: '', label: 'Choose a transformation…' },
              ...RULE_GROUPS.flatMap((g) =>
                g.kinds.map((k) => ({ value: k, label: `${g.label}: ${RULE_LABELS[k] ?? k}` })),
              ),
            ]}
          />
          <Button
            icon={<Plus className="h-4 w-4" />}
            disabled={!adding}
            data-testid="add-transformation"
            onClick={() => {
              if (!adding) return;
              setRules([...rules, defaultsFor(adding)]);
              setAdding('');
            }}
          >
            Add
          </Button>
        </div>

        {lossy && (
          <Callout tone="warning" title="This pipeline discards information">
            You will be asked to acknowledge it by name before the migration can run, and the acknowledgement
            is recorded in the run's audit trail.
          </Callout>
        )}

        <div>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
            Preview — real source values, the engine the migration uses
          </h3>
          {preview.isPending && <Spinner label="Running the pipeline…" />}
          {preview.error && <ErrorState error={preview.error} />}
          {preview.data && (
            <>
              <p className="mb-1 text-xs text-slate-500">
                {preview.data.previewed} value(s) previewed · {preview.data.valid} ok ·{' '}
                {preview.data.warnings} warning(s) · {preview.data.blocked} blocked
                {preview.data.sampled && ' · sampled from the first records'}
              </p>
              <Table className="max-h-64 overflow-y-auto">
                <thead>
                  <tr>
                    <Th>Source</Th>
                    <Th>Transformed</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody data-testid="preview-rows">
                  {preview.data.rows.map((row, i) => (
                    <tr key={i}>
                      <Td>{renderValue(row.sourceValue)}</Td>
                      <Td>{renderValue(row.transformedValue)}</Td>
                      <Td>
                        {row.status === 'OK' && <Pill tone="teal">ok</Pill>}
                        {row.status === 'WARNING' && <Pill tone="amber">{row.message ?? 'warning'}</Pill>}
                        {row.status === 'BLOCKED' && <Pill tone="red">{row.message ?? 'blocked'}</Pill>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </div>
        {save.error && <ErrorState error={save.error} />}
      </div>
    </Modal>
  );
}

function renderValue(value: string | null) {
  if (value === null) return <span className="text-slate-400">NULL</span>;
  if (value === '') return <span className="text-slate-400">(empty)</span>;
  // Quoted so leading and trailing spaces are visible, which is the whole point here.
  return <span className="font-mono text-xs">&quot;{value}&quot;</span>;
}

function defaultsFor(kind: TransformationKind): TransformationRule {
  switch (kind) {
    case 'TRUNCATE':
      return { kind, length: 100 };
    case 'SUBSTRING':
      return { kind, start: 0, length: 10 };
    case 'REPLACE':
      return { kind, find: '', replaceWith: '' };
    case 'TO_DATE':
    case 'TO_DATETIME':
      return { kind, inputFormat: null };
    case 'TO_BOOLEAN':
      return {
        kind,
        map: [
          { from: 'Y', to: true },
          { from: 'N', to: false },
        ],
      };
    case 'VALUE_MAP':
      return { kind, map: [], onUnmapped: 'BLOCK' };
    case 'CONCAT':
      return { kind, separator: ' ', parts: [], skipEmptyParts: true };
    default:
      return { kind };
  }
}

/** The inputs one rule needs. Everything is a form field: no rule accepts free-form code. */
function RuleParameters({
  rule,
  sourceFields,
  onChange,
}: {
  rule: TransformationRule;
  sourceFields: { logicalName: string; displayName: string }[];
  onChange: (patch: Partial<TransformationRule>) => void;
}) {
  const input = 'mt-1 rounded border border-slate-300 px-2 py-1 text-xs';
  switch (rule.kind) {
    case 'REPLACE':
      return (
        <div className="mt-2 flex flex-wrap gap-2">
          <label className="text-xs text-slate-600">
            Find
            <input
              className={`${input} ml-1`}
              value={rule.find ?? ''}
              onChange={(e) => onChange({ find: e.target.value })}
            />
          </label>
          <label className="text-xs text-slate-600">
            Replace with
            <input
              className={`${input} ml-1`}
              value={rule.replaceWith ?? ''}
              onChange={(e) => onChange({ replaceWith: e.target.value })}
            />
          </label>
        </div>
      );
    case 'TRUNCATE':
    case 'SUBSTRING':
      return (
        <div className="mt-2 flex flex-wrap gap-2">
          {rule.kind === 'SUBSTRING' && (
            <label className="text-xs text-slate-600">
              Start at
              <input
                type="number"
                className={`${input} ml-1 w-20`}
                value={rule.start ?? 0}
                onChange={(e) => onChange({ start: Number(e.target.value) })}
              />
            </label>
          )}
          <label className="text-xs text-slate-600">
            Length
            <input
              type="number"
              className={`${input} ml-1 w-24`}
              value={rule.length ?? 0}
              onChange={(e) => onChange({ length: Number(e.target.value) })}
            />
          </label>
        </div>
      );
    case 'PREFIX':
    case 'SUFFIX':
    case 'CONSTANT':
    case 'DEFAULT_IF_NULL':
    case 'DEFAULT_IF_BLANK':
      return (
        <label className="mt-2 block text-xs text-slate-600">
          Value
          <input
            className={`${input} ml-1`}
            value={String(rule.value ?? '')}
            onChange={(e) => onChange({ value: e.target.value })}
          />
        </label>
      );
    case 'TO_DATE':
    case 'TO_DATETIME':
      return (
        <div className="mt-2">
          <Select
            label="Input format"
            value={rule.inputFormat ?? ''}
            onChange={(v) => onChange({ inputFormat: v || null })}
            options={[
              { value: '', label: 'Standard (ISO) — an ambiguous date is refused' },
              ...DATE_FORMATS.map((f) => ({ value: f, label: f })),
            ]}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            A value like 01/02/2020 cannot be read without a format: it could be 2 January or 1 February, and
            guessing would move the date by a month.
          </p>
        </div>
      );
    case 'TO_DECIMAL':
      return (
        <label className="mt-2 block text-xs text-slate-600">
          Decimal places
          <input
            type="number"
            className={`${input} ml-1 w-20`}
            value={rule.scale ?? ''}
            onChange={(e) => onChange({ scale: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
      );
    case 'TO_BOOLEAN':
    case 'VALUE_MAP':
      return <ValueMapEditor rule={rule} onChange={onChange} />;
    case 'CONCAT':
      return (
        <div className="mt-2 space-y-1">
          <label className="text-xs text-slate-600">
            Separator
            <input
              className={`${input} ml-1 w-20`}
              value={rule.separator ?? ''}
              onChange={(e) => onChange({ separator: e.target.value })}
            />
          </label>
          <div className="flex flex-wrap gap-1">
            {(rule.parts ?? []).map((part, i) => (
              <span key={i} className="rounded bg-slate-100 px-2 py-0.5 text-xs">
                {part.field ?? `"${part.literal}"`}
                <button
                  type="button"
                  className="ml-1 text-slate-500"
                  aria-label={`Remove part ${i + 1}`}
                  onClick={() => onChange({ parts: (rule.parts ?? []).filter((_, n) => n !== i) })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <Select
            label="Add a source field"
            value=""
            onChange={(v) => v && onChange({ parts: [...(rule.parts ?? []), { field: v }] })}
            options={[
              { value: '', label: 'Add a field…' },
              ...sourceFields.map((f) => ({ value: f.logicalName, label: f.displayName })),
            ]}
          />
        </div>
      );
    default:
      return null;
  }
}

function ValueMapEditor({
  rule,
  onChange,
}: {
  rule: TransformationRule;
  onChange: (patch: Partial<TransformationRule>) => void;
}) {
  const entries = rule.map ?? [];
  const setEntry = (index: number, from: string, to: string) =>
    onChange({
      map: entries.map((e, i) => (i === index ? { from, to: coerce(to) } : e)),
    });
  return (
    <div className="mt-2 space-y-1">
      {entries.map((entry, i) => (
        <div key={i} className="flex items-center gap-1 text-xs">
          <input
            className="w-32 rounded border border-slate-300 px-2 py-1"
            value={entry.from}
            aria-label={`Source value ${i + 1}`}
            onChange={(e) => setEntry(i, e.target.value, String(entry.to ?? ''))}
          />
          <span className="text-slate-400">→</span>
          <input
            className="w-32 rounded border border-slate-300 px-2 py-1"
            value={String(entry.to ?? '')}
            aria-label={`Target value ${i + 1}`}
            onChange={(e) => setEntry(i, entry.from, e.target.value)}
          />
          <button
            type="button"
            className="text-slate-500"
            aria-label={`Remove mapping ${i + 1}`}
            onClick={() => onChange({ map: entries.filter((_, n) => n !== i) })}
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => onChange({ map: [...entries, { from: '', to: '' }] })}>
          Add a value
        </Button>
        <Select
          label="Unknown values"
          value={rule.onUnmapped ?? 'BLOCK'}
          onChange={(v) => onChange({ onUnmapped: v as 'BLOCK' | 'IGNORE' | 'DEFAULT' })}
          options={[
            { value: 'BLOCK', label: 'Block the record (safe default)' },
            { value: 'IGNORE', label: 'Leave the target empty' },
            { value: 'DEFAULT', label: 'Use a default value' },
          ]}
        />
        {rule.onUnmapped === 'DEFAULT' && (
          <input
            className="w-32 rounded border border-slate-300 px-2 py-1 text-xs"
            aria-label="Default value"
            value={String(rule.defaultValue ?? '')}
            onChange={(e) => onChange({ defaultValue: coerce(e.target.value) })}
          />
        )}
      </div>
    </div>
  );
}

/** Keeps a numeric or boolean target value typed rather than turning everything into text. */
function coerce(value: string): string | number | boolean | null {
  if (value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isFinite(n) && value.trim() !== '' ? n : value;
}
