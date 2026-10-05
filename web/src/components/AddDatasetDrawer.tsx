import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Database, FileCode, FileSpreadsheet, Plug, Upload } from 'lucide-react';
import type { EnvironmentDto, StagedPreviewDto, StagedPreviewTableDto, ProjectDto } from '@shared/domain';
import { Button, Callout, Card, ErrorState, Field, Modal, Spinner, cx } from './ui';
import { api } from '../lib/api';

/**
 * Adding data to an analysis project.
 *
 * Three decisions in order, and only one visible at a time: **what kind of thing**, then **which one**,
 * then **is this right**. The previous experience put a connection form in front of somebody who had not
 * yet said what they were connecting to, which is why it was unusable — the configuration arrived before
 * the question it answers.
 *
 * Nothing here routes away. The whole flow happens in this panel and ends with the dataset attached to the
 * project, which is the point of the phase.
 */

type Step = 'gallery' | 'file' | 'connection';

/**
 * How far a connector actually gets, in the only four answers worth giving.
 *
 * `FULL` means the whole journey works: connect, see what is there, choose it, look at it, add it.
 * Anything less is named rather than rounded up. Eight cards that each stop somewhere different, all
 * looking identical, is the version of this screen that costs somebody a week of planning.
 */
type Availability = 'FULL' | 'CONNECTION_ONLY' | 'SIMULATED' | 'COMING_SOON';

interface Connector {
  id: string;
  name: string;
  category: 'Files' | 'Databases' | 'Microsoft';
  blurb: string;
  icon: typeof Database;
  availability: Availability;
  /** What the state means for this connector, in one line. Required for anything short of `FULL`. */
  caveat?: string;
  step: Step;
  connectionType?: string;
}

/**
 * What this product can actually read today.
 *
 * `SIMULATED` is on the card, not in a footnote. Dataverse has never been executed against a real
 * environment — see docs/DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md — and a gallery that showed it
 * identically to CSV would be the most expensive kind of lie this product could tell, because somebody
 * would plan around it.
 */
const CONNECTORS: Connector[] = [
  {
    id: 'csv',
    name: 'CSV',
    category: 'Files',
    blurb: 'Comma, semicolon or tab separated. The usual shape of a legacy export.',
    icon: FileSpreadsheet,
    availability: 'FULL',
    step: 'file',
  },
  {
    id: 'excel',
    name: 'Excel',
    category: 'Files',
    blurb: 'A workbook. Choose which sheets you want — the notes tab does not have to come with them.',
    icon: FileSpreadsheet,
    availability: 'FULL',
    step: 'file',
  },
  {
    id: 'xml',
    name: 'XML',
    category: 'Files',
    blurb: 'A record-per-element export. Attributes and child elements become columns.',
    icon: FileCode,
    availability: 'FULL',
    step: 'file',
  },
  {
    id: 'sqlserver',
    name: 'SQL Server',
    category: 'Databases',
    blurb: 'On-premises or hosted. Verified against real SQL Server instances.',
    icon: Database,
    availability: 'CONNECTION_ONLY',
    caveat: 'Everything in the database is analysed together. Choosing individual tables is not built yet.',
    step: 'connection',
    connectionType: 'SQL_SERVER',
  },
  {
    id: 'azuresql',
    name: 'Azure SQL',
    category: 'Databases',
    blurb: 'Azure SQL Database.',
    icon: Database,
    availability: 'SIMULATED',
    caveat:
      'Never run against a real Azure SQL database. Shares a driver with SQL Server, which is not evidence.',
    step: 'connection',
    connectionType: 'AZURE_SQL',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'Databases',
    blurb: 'Verified against real PostgreSQL servers.',
    icon: Database,
    availability: 'CONNECTION_ONLY',
    caveat: 'Everything in the database is analysed together. Choosing individual tables is not built yet.',
    step: 'connection',
    connectionType: 'POSTGRES',
  },
  {
    id: 'dataverse',
    name: 'Microsoft Dataverse',
    category: 'Microsoft',
    blurb: 'Dynamics 365 and Power Platform environments.',
    icon: Plug,
    availability: 'SIMULATED',
    caveat: 'Implemented and tested against a simulator. Never run against a real Dataverse environment.',
    step: 'connection',
    connectionType: 'DATAVERSE',
  },
];

const AVAILABILITY_CHIP: Record<Availability, { label: string; cls: string } | null> = {
  FULL: null,
  CONNECTION_ONLY: { label: 'Connection only', cls: 'bg-sky-50 text-sky-800 ring-sky-200' },
  SIMULATED: { label: 'Simulated', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  COMING_SOON: { label: 'Coming soon', cls: 'bg-slate-100 text-slate-500 ring-slate-200' },
};

export function AddDatasetDrawer({
  project,
  open,
  onClose,
  onAdded,
}: {
  project: ProjectDto;
  open: boolean;
  onClose: () => void;
  /** Called instead of `onClose` when something was actually added, so the caller can show it. */
  onAdded?: () => void;
}) {
  const [step, setStep] = useState<Step>('gallery');
  const [connector, setConnector] = useState<Connector | null>(null);

  const reset = () => {
    setStep('gallery');
    setConnector(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const added = () => {
    reset();
    (onAdded ?? onClose)();
  };

  return (
    <Modal open={open} onClose={close} title="Add a dataset" wide>
      {step !== 'gallery' && (
        <button
          type="button"
          onClick={reset}
          className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          All sources
        </button>
      )}

      {step === 'gallery' && (
        <Gallery
          onChoose={(c) => {
            setConnector(c);
            setStep(c.step);
          }}
        />
      )}
      {step === 'file' && connector && <FileDataset project={project} connector={connector} onDone={added} />}
      {step === 'connection' && connector && (
        <ExistingConnection project={project} connector={connector} onDone={added} />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function Gallery({ onChoose }: { onChoose: (c: Connector) => void }) {
  const categories = ['Files', 'Databases', 'Microsoft'] as const;
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-600">Where does this data live?</p>
      {categories.map((category) => (
        <section key={category}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{category}</h3>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {CONNECTORS.filter((c) => c.category === category).map((connector) => {
              const Icon = connector.icon;
              const chip = AVAILABILITY_CHIP[connector.availability];
              const disabled = connector.availability === 'COMING_SOON';
              return (
                <button
                  key={connector.id}
                  type="button"
                  data-testid={`connector-${connector.id}`}
                  disabled={disabled}
                  onClick={() => onChoose(connector)}
                  className={cx(
                    'flex gap-3 rounded-lg border p-3 text-left transition-colors',
                    disabled
                      ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60'
                      : 'border-slate-200 bg-white hover:border-brand-300 hover:bg-brand-50/30',
                  )}
                >
                  <Icon className="mt-0.5 h-5 w-5 flex-none text-slate-400" aria-hidden />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold text-slate-900">{connector.name}</span>
                      {chip && (
                        <span
                          className={cx(
                            'rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset',
                            chip.cls,
                          )}
                        >
                          {chip.label}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{connector.blurb}</p>
                    {connector.caveat && (
                      <p className="mt-1 text-xs leading-relaxed text-amber-800">{connector.caveat}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * A file becomes one or more datasets: choose it, see what is in it, pick the sheets, add them.
 *
 * The preview is the part that matters. It runs the real reader and the real type inference and stores
 * nothing, so somebody can see that the dates came through as five-digit numbers *before* the dataset
 * exists rather than after.
 *
 * Sheet selection exists because a real workbook is not a table. `CustomerMigration.xlsx` holds Customers,
 * Contacts and Orders — and an "Instructions" tab, and a "Lookup Notes" tab. Importing all five produced
 * two datasets nobody asked for, which then appeared in findings and pulled down a readiness score.
 */
function FileDataset({
  project,
  connector,
  onDone,
}: {
  project: ProjectDto;
  connector: Connector;
  onDone: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const queryClient = useQueryClient();

  const preview = useMutation({
    mutationFn: async (picked: { name: string; base64: string }) =>
      api<StagedPreviewDto>('POST', '/api/staged-sources/preview', {
        filename: picked.name,
        contentBase64: picked.base64,
      }),
    // Everything readable starts selected. Guessing which sheets somebody means from their names would be
    // a guess, and the one it got wrong would be the one that mattered.
    onSuccess: (data) => setChosen(new Set(data.tables.map((t) => t.sheet))),
  });

  const tables = preview.data?.tables ?? [];
  const multi = tables.length > 1;
  const selected = tables.filter((t) => chosen.has(t.sheet));

  const add = useMutation({
    mutationFn: async () => {
      /*
       * The connection is created here because a file dataset has no credentials to reuse — the file is
       * the whole thing. It is an implementation detail and is never named on screen: what the user added
       * is a dataset, and that is the only word this flow uses.
       */
      const environment = await api<EnvironmentDto>('POST', '/api/staged-sources', {
        displayName: (multi ? file!.name : name.trim()) || file!.name,
        kind: 'UPLOAD',
      });
      await api('POST', `/api/staged-sources/${environment.id}/import`, {
        filename: file!.name,
        contentBase64: file!.base64,
        sheets: selected.map((t) => t.sheet),
      });
      await api('POST', `/api/projects/${project.id}/sources`, { environmentId: environment.id });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['assessment', project.id] });
      await queryClient.invalidateQueries({ queryKey: ['project', project.id] });
      onDone();
    },
  });

  const choose = async (picked: File) => {
    const buffer = await picked.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
    const next = { name: picked.name, base64: btoa(binary) };
    setFile(next);
    // The dataset's name defaults to the file's, without the extension, because that is what people call it.
    setName(picked.name.replace(/\.[^.]+$/, ''));
    setChosen(new Set());
    preview.mutate(next);
  };

  const accept = connector.id === 'excel' ? '.xlsx,.xls' : '.csv,.tsv,.txt,.xml';

  return (
    <div className="space-y-4">
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        className="sr-only"
        data-testid="dataset-file-input"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) void choose(picked);
        }}
      />

      {!file && (
        <div
          data-testid="dataset-dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) void choose(dropped);
          }}
          className={cx(
            'rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors',
            dragging ? 'border-brand-500 bg-brand-50/60' : 'border-slate-300 bg-slate-50',
          )}
        >
          <Upload className="mx-auto h-6 w-6 text-slate-400" aria-hidden />
          <p className="mt-2 text-sm font-medium text-slate-700">
            Drop a {connector.id === 'excel' ? 'workbook' : 'CSV, Excel or XML file'} here
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Nothing is stored until you have seen what is in it.
          </p>
          <Button className="mt-3" variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
            Choose file
          </Button>
        </div>
      )}

      {preview.isPending && <Spinner label="Reading the file…" />}
      {preview.error && <ErrorState error={preview.error} />}

      {preview.data && (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold text-slate-900">{preview.data.filename}</h3>
            <span className="text-xs text-slate-500">
              {multi ? `${tables.length} sheets detected` : '1 table'} ·{' '}
              {Math.max(1, Math.round(preview.data.bytes / 1024))} KB
            </span>
          </div>

          {/*
            A single-table file *is* the dataset, so it gets a name. A workbook's sheets name themselves,
            and asking for a name as well would be asking for a name nothing uses.
          */}
          {!multi && (
            <Field
              label="Dataset name"
              htmlFor="dataset-name"
              hint="What this data is called in the project."
            >
              <input
                id="dataset-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </Field>
          )}

          {multi && (
            <p className="text-sm text-slate-600">
              Which sheets do you want to analyse? Each one becomes its own dataset.
            </p>
          )}

          <div data-testid="dataset-preview" className="space-y-3">
            {tables.map((table) => (
              <PreviewTable
                key={table.sheet}
                table={table}
                selectable={multi}
                checked={chosen.has(table.sheet)}
                onToggle={() =>
                  setChosen((previous) => {
                    const next = new Set(previous);
                    if (next.has(table.sheet)) next.delete(table.sheet);
                    else next.add(table.sheet);
                    return next;
                  })
                }
              />
            ))}
            {preview.data.skipped.length > 0 && (
              <Callout tone="warning" title="Some sheets had nothing to read">
                {preview.data.skipped.map((s) => `${s.name} — ${s.reason}`).join('; ')}
              </Callout>
            )}
            {tables.length === 0 && (
              <Callout tone="danger" title="Nothing usable in this file">
                No sheet had a header row with values beneath it.
              </Callout>
            )}
          </div>

          {add.error && <ErrorState error={add.error} />}

          <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
            <Button variant="ghost" onClick={() => fileInput.current?.click()}>
              Choose a different file
            </Button>
            <Button
              variant="primary"
              data-testid="confirm-add-dataset"
              disabled={selected.length === 0 || (!multi && !name.trim())}
              loading={add.isPending}
              onClick={() => add.mutate()}
            >
              {selected.length > 1 ? `Add ${selected.length} datasets` : 'Add dataset'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** One table found in the file: its shape, its columns, and a few rows of it. */
function PreviewTable({
  table,
  selectable,
  checked,
  onToggle,
}: {
  table: StagedPreviewTableDto;
  selectable: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const [showRows, setShowRows] = useState(false);
  return (
    <Card
      className={cx(selectable && !checked && 'opacity-60')}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {selectable && (
            <input
              type="checkbox"
              checked={checked}
              onChange={onToggle}
              aria-label={`Analyse ${table.displayName}`}
              data-testid={`sheet-${table.sheet}`}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
          )}
          {table.displayName}
          {table.sheetName && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-500">
              sheet: {table.sheetName}
            </span>
          )}
        </span>
      }
      subtitle={`${table.rowCount.toLocaleString()} rows · ${table.columnCount} columns`}
      bodyClassName="p-0"
    >
      {/*
        The identifier question, answered here rather than three screens later. Whether a row can be
        recognised again decides whether this data can be compared, de-duplicated or migrated at all, and
        it is cheap to say now and expensive to discover during a run.
      */}
      <div
        className={cx(
          'border-b px-3 py-2 text-xs',
          table.keyColumn
            ? 'border-slate-100 bg-slate-50 text-slate-600'
            : 'border-amber-100 bg-amber-50 text-amber-800',
        )}
      >
        {table.keyColumn ? (
          <>
            <span className="font-mono">{table.keyColumn}</span> looks like a possible record identifier.
          </>
        ) : (
          'No reliable record identifier was detected — rows will be counted rather than matched.'
        )}
      </div>
      <div className="max-h-56 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-1.5 font-medium text-slate-500">Column</th>
              <th className="px-3 py-1.5 font-medium text-slate-500">Stored as</th>
              <th className="px-3 py-1.5 font-medium text-slate-500">Detected meaning</th>
              <th className="px-3 py-1.5 text-right font-medium text-slate-500">Empty</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((column) => (
              <tr key={column.name} className="border-t border-slate-100">
                <td className="px-3 py-1.5 font-mono text-[11px] text-slate-800">{column.name}</td>
                <td className="px-3 py-1.5 text-slate-600">{column.type}</td>
                <td className="px-3 py-1.5">
                  {/*
                    The reason the preview exists. "Integer" is true and useless for a column of Excel
                    serial dates; this is where somebody sees that before the dataset is created.
                  */}
                  {column.semantic ? (
                    <span className="text-amber-800">{column.semantic.label}</span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">
                  {column.blanks > 0 ? column.blanks.toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-100 px-3 py-2">
        <Button size="sm" variant="ghost" onClick={() => setShowRows(!showRows)}>
          {showRows ? 'Hide sample rows' : `Sample rows (${table.sampleRows.length})`}
        </Button>
        {showRows && (
          <div className="mt-2 max-h-48 overflow-auto rounded border border-slate-100">
            <table className="w-full text-[11px]">
              <thead className="bg-slate-50 text-left">
                <tr>
                  {table.columns.map((c) => (
                    <th key={c.name} className="whitespace-nowrap px-2 py-1 font-medium text-slate-500">
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.sampleRows.map((row, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    {table.columns.map((c, j) => (
                      <td key={c.name} className="whitespace-nowrap px-2 py-1 text-slate-700">
                        {row[j] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

/**
 * A database or Dataverse dataset: choose a connection that already exists.
 *
 * Connections are workspace assets and creating one is its own job, done on the Connections page where it
 * belongs. Putting a credentials form inside "add a dataset" is what made the old experience confusing —
 * two different decisions sharing one screen.
 */
function ExistingConnection({
  project,
  connector,
  onDone,
}: {
  project: ProjectDto;
  connector: Connector;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const environments = useQuery({
    queryKey: ['environments'],
    queryFn: () => api<EnvironmentDto[]>('GET', '/api/environments'),
  });

  const add = useMutation({
    mutationFn: (environmentId: string) =>
      api('POST', `/api/projects/${project.id}/sources`, { environmentId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['assessment', project.id] });
      await queryClient.invalidateQueries({ queryKey: ['project', project.id] });
      onDone();
    },
  });

  if (environments.isLoading) return <Spinner label="Loading connections…" />;
  if (environments.error) return <ErrorState error={environments.error} />;

  const matching = (environments.data ?? []).filter((e) => e.connectionType === connector.connectionType);

  return (
    <div className="space-y-4">
      {/* Whatever this connector cannot do, said here as well as on the card — this is the screen where
          somebody is about to commit to it. */}
      {connector.availability !== 'FULL' && connector.caveat && (
        <Callout
          tone={connector.availability === 'SIMULATED' ? 'warning' : 'info'}
          title={
            connector.availability === 'SIMULATED'
              ? `${connector.name} is not certified`
              : `What ${connector.name} can do today`
          }
        >
          {connector.caveat}
        </Callout>
      )}

      {matching.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-center">
          <Database className="mx-auto h-6 w-6 text-slate-400" aria-hidden />
          <h3 className="mt-2 text-sm font-semibold text-slate-900">No {connector.name} connection yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            A connection holds the credentials for reaching a system, and is reusable across projects. Create
            one on the Connections page, then come back and choose it here.
          </p>
          <a
            href="/environments"
            className="mt-3 inline-block rounded-md bg-brand-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-800"
          >
            Go to Connections
          </a>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            Choose a connection. It stays available to your other projects.
          </p>
          <ul className="space-y-2">
            {matching.map((environment) => (
              <li key={environment.id}>
                <button
                  type="button"
                  data-testid={`choose-connection-${environment.id}`}
                  disabled={add.isPending}
                  onClick={() => add.mutate(environment.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3 text-left hover:border-brand-300 hover:bg-brand-50/30"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-900">
                      {environment.displayName}
                    </span>
                    <span className="block truncate text-xs text-slate-500">{environment.url}</span>
                  </span>
                  {environment.connectionStatus === 'CONNECTED' && (
                    <CheckCircle2 className="h-4 w-4 flex-none text-emerald-600" aria-label="verified" />
                  )}
                </button>
              </li>
            ))}
          </ul>
          {add.error && <ErrorState error={add.error} />}
        </>
      )}
    </div>
  );
}
