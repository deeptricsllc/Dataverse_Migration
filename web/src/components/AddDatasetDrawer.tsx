import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Database, FileSpreadsheet, Search, Upload } from 'lucide-react';
import type {
  ConnectionType,
  EnvironmentDto,
  ProfileDto,
  ProjectDto,
  StagedPreviewDto,
  StagedPreviewTableDto,
} from '@shared/domain';
import type { GraphDriveItem, GraphList, GraphSite } from '../../../server/src/connectors/staged/graph';
import { Button, Callout, Card, Disclosure, ErrorState, Field, Modal, Spinner, cx } from './ui';
import { api } from '../lib/api';
import { ObjectPicker } from './ObjectPicker';
import { describeCount } from '../lib/format';
import { ConnectionModal } from './ConnectionForm';
import { availabilityOf, CONNECTORS, SourceGallery, type Connector } from './SourceGallery';

/**
 * What the upload step accepts, and how much of it.
 *
 * The size ceiling is the server's 48 MB body limit less the third that base64 adds, rounded down.
 * Checked here as well as there because the server can only refuse after the whole file has been
 * encoded and sent, which on a slow connection is a long wait for a number nobody can act on.
 */
const MAX_UPLOAD_MB = 36;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const EXCEL_EXTENSIONS = '.xlsx';
const TABULAR_EXTENSIONS = '.csv,.tsv,.txt,.xml';

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

type Step = 'gallery' | 'file' | 'connection' | 'microsoft';

/**
 * How far a connector actually gets, in the only four answers worth giving.
 *
 * `FULL` means the whole journey works: connect, see what is there, choose it, look at it, add it.
 * Anything less is named rather than rounded up. Eight cards that each stop somewhere different, all
 * looking identical, is the version of this screen that costs somebody a week of planning.
 */
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
        <SourceGallery
          connectors={CONNECTORS}
          intro="Where does this data live?"
          onChoose={(c) => {
            setConnector(c);
            // Every connector in this gallery has a step; the upload card that does not is only
            // shown on the connections screen, which routes rather than advancing a drawer.
            if (c.step) setStep(c.step);
          }}
        />
      )}
      {step === 'file' && connector && <FileDataset project={project} connector={connector} onDone={added} />}
      {step === 'connection' && connector && (
        <DatabaseDataset project={project} connector={connector} onDone={added} />
      )}
      {step === 'microsoft' && connector && (
        <MicrosoftDataset project={project} connector={connector} onDone={added} />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

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
  /**
   * The files still to review, when more than one was chosen.
   *
   * Each is previewed, has its sheets chosen and is imported in turn, rather than all of them being
   * flattened into one list. A workbook's sheets are a decision; four workbooks' sheets in one list
   * is a decision nobody reads, and "select all" on it is how a notes tab becomes a dataset.
   */
  const [queue, setQueue] = useState<File[]>([]);
  const [queueAt, setQueueAt] = useState(0);
  const [rejected, setRejected] = useState<string | null>(null);
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
      // On to the next file, or out of the drawer when that was the last one.
      const next = queueAt + 1;
      if (next < queue.length) {
        setQueueAt(next);
        setFile(null);
        preview.reset();
        void load(queue[next]!);
        return;
      }
      onDone();
    },
  });

  /** Reads one file into the shape the preview endpoint takes. */
  const load = async (picked: File) => {
    const bytes = new Uint8Array(await picked.arrayBuffer());
    /*
     * Chunked rather than one character at a time. `String.fromCharCode(...bytes)` overflows the
     * call stack on a large file and appending byte by byte is quadratic in practice; neither
     * failure is one a person could diagnose from the spinner that would be on screen.
     */
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const next = { name: picked.name, base64: btoa(binary) };
    setFile(next);
    // The dataset's name defaults to the file's, without the extension, because that is what people call it.
    setName(picked.name.replace(/\.[^.]+$/, ''));
    setChosen(new Set());
    preview.mutate(next);
  };

  /**
   * Accepts what was dropped or browsed to, refusing what cannot work before anything is uploaded.
   *
   * Both checks exist because the alternative is a long wait and then a failure nobody can read: an
   * unsupported file comes back as a parser error about its contents, and an oversized one comes
   * back as a bare 413 after the whole thing has been encoded and sent.
   */
  const choose = (picked: File[]) => {
    if (picked.length === 0) return;
    const allowed = accept.split(',');
    const wrongType = picked.filter((f) => !allowed.some((ext) => f.name.toLowerCase().endsWith(ext)));
    if (wrongType.length > 0) {
      /*
       * Legacy .xls gets its own sentence because it is the one refusal a person will read as the
       * product being broken. The reader handles the OOXML package that .xlsx is; the 1997 binary
       * format is a different file format wearing a similar name, and it was being advertised in
       * the file picker without ever having been supported.
       */
      const legacyXls = wrongType.some((f) => f.name.toLowerCase().endsWith('.xls'));
      setRejected(
        legacyXls
          ? 'The older .xls format is not supported. Open the file in Excel and save it as .xlsx, or export it as CSV, then upload that.'
          : `${wrongType.map((f) => f.name).join(', ')} cannot be read here. This step accepts ${allowed.join(', ')}.`,
      );
      return;
    }
    const tooBig = picked.filter((f) => f.size > MAX_UPLOAD_BYTES);
    if (tooBig.length > 0) {
      setRejected(
        `${tooBig.map((f) => f.name).join(', ')} is larger than ${MAX_UPLOAD_MB} MB. Split the file, or load data this size from a database connection instead.`,
      );
      return;
    }
    setRejected(null);
    setQueue(picked);
    setQueueAt(0);
    void load(picked[0]!);
  };

  const accept = connector.id === 'excel' ? EXCEL_EXTENSIONS : TABULAR_EXTENSIONS;

  return (
    <div className="space-y-4">
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        multiple
        className="sr-only"
        data-testid="dataset-file-input"
        onChange={(e) => choose([...(e.target.files ?? [])])}
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
            choose([...(e.dataTransfer.files ?? [])]);
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
            One file or several. Up to {MAX_UPLOAD_MB} MB each. Nothing is stored until you have seen what is
            in it.
          </p>
          <Button className="mt-3" variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
            Choose files
          </Button>
        </div>
      )}

      {rejected && (
        <div data-testid="upload-rejected">
          <Callout tone="warning">{rejected}</Callout>
        </div>
      )}

      {queue.length > 1 && (
        <p className="text-xs font-medium text-slate-500" data-testid="upload-queue">
          File {queueAt + 1} of {queue.length}: {queue[queueAt]?.name}
        </p>
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
              Which sheets do you want to analyze? Each one becomes its own dataset.
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

          <div className="sticky bottom-0 -mx-5 -mb-4 flex items-center justify-between gap-2 border-t border-slate-100 bg-white px-5 py-3">
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
              aria-label={`Analyze ${table.displayName}`}
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
        recognized again decides whether this data can be compared, de-duplicated or migrated at all, and
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
          'No reliable record identifier was detected. Rows will be counted rather than matched.'
        )}
      </div>
      <DetailWrapper selectable={selectable}>
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
      </DetailWrapper>
    </Card>
  );
}

/**
 * The columns and rows of one sheet, folded away while there is a choice to make.
 *
 * A five-sheet workbook rendered five full column tables, so choosing which sheets to take meant
 * scrolling past four screens of detail you had not asked for. A single-table file has no choice to make,
 * so its detail is the whole point and stays open.
 */
function DetailWrapper({ selectable, children }: { selectable: boolean; children: ReactNode }) {
  if (!selectable) return <>{children}</>;
  return (
    <div className="px-3 py-2">
      <Disclosure summary={<span className="text-xs text-slate-500">Columns and sample rows</span>}>
        <div className="-mx-3">{children}</div>
      </Disclosure>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * A database becomes datasets: choose the connection, see what is in it, pick the tables, look at one, add.
 *
 * The connection is a means, not the destination. The previous version of this step ended at "choose a
 * connection", which added *the whole database* to the project — every table in every schema, including the
 * audit tables and the staging copies somebody left behind in 2019. The person had asked for Customers.
 *
 * Nothing here routes away. Creating a connection happens in place and continues to the data, because
 * sending somebody to a connections page and expecting them to remember why they went is how the old
 * experience lost people.
 */
function DatabaseDataset({
  project,
  connector,
  onDone,
}: {
  project: ProjectDto;
  connector: Connector;
  onDone: () => void;
}) {
  const [connection, setConnection] = useState<EnvironmentDto | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  /**
   * Dataverse environments are discovered rather than typed in, so "create a connection" means "ask
   * Microsoft which environments this account can reach". Wired to the real thing: a button that closed
   * the panel and discovered nothing would be worse than no button.
   */
  const discover = useMutation({
    mutationFn: () => api<EnvironmentDto[]>('POST', '/api/environments/discover'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['environments'] });
      setCreating(false);
    },
  });

  if (connection) {
    return (
      <BrowseConnection
        project={project}
        connection={connection}
        onBack={() => setConnection(null)}
        onDone={onDone}
      />
    );
  }

  return (
    <>
      <ChooseConnection connector={connector} onChoose={setConnection} onCreate={() => setCreating(true)} />
      {creating && (
        <ConnectionModal
          connection={null}
          initialType={connector.connectionType as ConnectionType}
          onClose={() => setCreating(false)}
          onDiscover={() => discover.mutate()}
          discovering={discover.isPending}
          // Straight on to the data. A stored credential is infrastructure; the thing they came for is next.
          onSaved={(saved) => {
            setCreating(false);
            setConnection(saved);
          }}
        />
      )}
    </>
  );
}

/** The connections of this kind that already exist, and the way to make another. */
function ChooseConnection({
  connector,
  onChoose,
  onCreate,
}: {
  connector: Connector;
  onChoose: (connection: EnvironmentDto) => void;
  onCreate: () => void;
}) {
  const environments = useQuery({
    queryKey: ['environments'],
    queryFn: () => api<EnvironmentDto[]>('GET', '/api/environments'),
  });

  if (environments.isLoading) return <Spinner label="Loading connections…" />;
  if (environments.error) return <ErrorState error={environments.error} />;

  const matching = (environments.data ?? []).filter((e) => e.connectionType === connector.connectionType);

  return (
    <div className="space-y-4">
      {connector.caveat && (
        <Callout
          tone={availabilityOf(connector) === 'SIMULATED' ? 'warning' : 'info'}
          title={
            availabilityOf(connector) === 'SIMULATED'
              ? `${connector.name} is not certified`
              : `What ${connector.name} can do today`
          }
        >
          {connector.caveat}
        </Callout>
      )}

      {matching.length > 0 && (
        <>
          <p className="text-sm text-slate-600">
            Use a connection you already have. It stays available to your other projects.
          </p>
          <ul className="space-y-2">
            {matching.map((environment) => (
              <li key={environment.id}>
                <button
                  type="button"
                  data-testid={`choose-connection-${environment.id}`}
                  onClick={() => onChoose(environment)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3 text-left hover:border-brand-300 hover:bg-brand-50/30"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-900">
                      {environment.displayName}
                    </span>
                    <span className="block truncate text-xs text-slate-500">{environment.url}</span>
                  </span>
                  <span className="flex flex-none items-center gap-2">
                    {environment.connectionStatus === 'CONNECTED' && (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="connected" />
                    )}
                    <span className="text-xs font-medium text-brand-700">Browse data</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {matching.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-center">
          <Database className="mx-auto h-6 w-6 text-slate-400" aria-hidden />
          <h3 className="mt-2 text-sm font-semibold text-slate-900">No {connector.name} connection yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            A connection holds the details for reaching a server, and is reusable across projects.
          </p>
        </div>
      )}

      <Button
        variant={matching.length ? 'secondary' : 'primary'}
        onClick={onCreate}
        data-testid="new-connection"
      >
        Connect to {connector.name}
      </Button>
    </div>
  );
}

/**
 * What is in this database, and which of it the project wants.
 *
 * Grouped by schema and searchable, because a real database has hundreds of tables and a flat list of
 * hundreds is the same as no list. Row counts are deliberately absent here: counting every table to draw a
 * list would be a hundred queries to answer a question nobody asked yet. The preview counts the ones that
 * were chosen.
 */
function BrowseConnection({
  project,
  connection,
  onBack,
  onDone,
}: {
  project: ProjectDto;
  connection: EnvironmentDto;
  onBack: () => void;
  onDone: () => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const add = useMutation({
    mutationFn: () =>
      api('POST', `/api/projects/${project.id}/sources`, {
        environmentId: connection.id,
        objects: [...chosen],
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['assessment', project.id] });
      await queryClient.invalidateQueries({ queryKey: ['project', project.id] });
      onDone();
    },
  });

  const toggle = (name: string) =>
    setChosen((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Choose data</h3>
          <p className="text-xs text-slate-500">{connection.displayName}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          Different connection
        </Button>
      </div>

      {/* The same picker the migration workspace uses to choose its scope. */}
      <ObjectPicker connection={connection} chosen={chosen} onToggle={toggle} onPreview={setPreviewing} />

      {add.error && <ErrorState error={add.error} />}

      <div className="sticky bottom-0 -mx-5 -mb-4 flex items-center justify-between gap-2 border-t border-slate-100 bg-white px-5 py-3">
        <span className="text-xs text-slate-500">
          {chosen.size === 0 ? 'Nothing chosen yet' : describeCount(chosen.size, 'table')} selected
        </span>
        <Button
          variant="primary"
          data-testid="confirm-add-dataset"
          disabled={chosen.size === 0}
          loading={add.isPending}
          onClick={() => add.mutate()}
        >
          {chosen.size > 1 ? `Add ${chosen.size} datasets` : 'Add dataset'}
        </Button>
      </div>

      {previewing && (
        <ObjectPreview connection={connection} table={previewing} onClose={() => setPreviewing(null)} />
      )}
    </div>
  );
}

/** One cell, rendered the way a person reads it rather than the way the API returns it. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value !== null && 'logicalName' in value) {
    // A lookup is a reference to a record elsewhere; its id is noise in a preview.
    return String((value as { logicalName: string }).logicalName);
  }
  return String(value);
}

/**
 * Enough of one table to know it is the right one.
 *
 * Counts and reads a sample through the same path the analysis uses, so what is shown is what would be
 * read. Opened per table rather than for everything chosen: counting and sampling thirty tables to confirm
 * a selection would cost more than the selection is worth.
 */
function ObjectPreview({
  connection,
  table,
  onClose,
}: {
  connection: EnvironmentDto;
  table: string;
  onClose: () => void;
}) {
  const profile = useQuery({
    queryKey: ['object-preview', connection.id, table],
    queryFn: () =>
      api<ProfileDto>(
        'GET',
        `/api/environments/${connection.id}/tables/${encodeURIComponent(table)}/profile`,
      ),
  });

  const fields = profile.data ? profile.data.nullStats.slice(0, 12) : [];
  const sample = profile.data?.sampleRecords.slice(0, 5) ?? [];
  // Enough columns to recognize the table, few enough that the row does not have to be scrolled to read.
  const sampleColumns = profile.data ? profile.data.nullStats.slice(0, 6).map((f) => f.field) : [];

  return (
    <Modal open onClose={onClose} wide title={table}>
      {profile.isLoading && <Spinner label="Counting and reading a sample…" />}
      {profile.error && <ErrorState error={profile.error} />}
      {profile.data && (
        <div className="space-y-3" data-testid="object-preview">
          <p className="text-sm text-slate-600">
            {profile.data.countApproximate ? 'About ' : ''}
            {profile.data.count.toLocaleString()} rows · {profile.data.nullStats.length} columns
          </p>
          <p className="text-xs text-slate-500">
            Identified by <span className="font-mono">{profile.data.primaryIdAttribute}</span>
          </p>
          <div className="max-h-72 overflow-auto rounded border border-slate-100">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-left">
                <tr>
                  <th className="px-3 py-1.5 font-medium text-slate-500">Column</th>
                  <th className="px-3 py-1.5 text-right font-medium text-slate-500">Empty</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field) => (
                  <tr key={field.field} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 font-mono text-[11px] text-slate-800">{field.field}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">
                      {field.nullPercent > 0 ? `${field.nullPercent}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/*
            The values themselves. Column names and null percentages describe the shape; this is what
            tells somebody they have picked the customer table and not the customer *audit* table, which
            is the mistake this preview exists to catch.
          */}
          {sample.length > 0 && (
            <div className="max-h-48 overflow-auto rounded border border-slate-100">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-slate-50 text-left">
                  <tr>
                    {sampleColumns.map((name) => (
                      <th key={name} className="whitespace-nowrap px-2 py-1 font-medium text-slate-500">
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sample.map((record, i) => (
                    <tr key={record.id ?? i} className="border-t border-slate-100">
                      {sampleColumns.map((name) => (
                        <td key={name} className="whitespace-nowrap px-2 py-1 text-slate-700">
                          {renderValue(record.values[name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-400">
            Measured from a sample of {profile.data.sampleSize.toLocaleString()} records.
          </p>
        </div>
      )}
    </Modal>
  );
}

/**
 * SharePoint and OneDrive: connect, find the content, add it.
 *
 * The integrity problem this replaces: choosing SharePoint created a connection, nothing was selected from
 * it, and the product let the analysis path continue — so an authenticated connection holding nothing
 * looked exactly like a dataset. The server refuses that now. This is the other half: a journey that
 * actually reaches content, instead of a dead end that asked for `sites/{site-id}/lists/{list-id}` — a pair
 * of ids that appear in no URL anybody ever sees.
 *
 * **What is proven and what is not.** Every Graph call below is tested against a simulated Graph, and none
 * has ever been executed against a real Microsoft tenant. It also needs a Microsoft sign-in, so a demo
 * workspace cannot reach it at all. The card says so before anybody starts, and the error below says so
 * again if they do.
 */
function MicrosoftDataset({
  project,
  connector,
  onDone,
}: {
  project: ProjectDto;
  connector: Connector;
  onDone: () => void;
}) {
  const kind = connector.id === 'onedrive' ? 'ONEDRIVE' : 'SHAREPOINT';
  const [connection, setConnection] = useState<EnvironmentDto | null>(null);
  const [site, setSite] = useState<GraphSite | null>(null);
  const queryClient = useQueryClient();

  const existing = useQuery({
    queryKey: ['environments'],
    queryFn: () => api<EnvironmentDto[]>('GET', '/api/environments'),
  });

  const connect = useMutation({
    mutationFn: () =>
      api<EnvironmentDto>('POST', '/api/staged-sources', {
        displayName: connector.name,
        kind: kind === 'ONEDRIVE' ? 'ONEDRIVE' : 'SHAREPOINT',
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['environments'] });
      setConnection(created);
    },
  });

  if (existing.isLoading) return <Spinner label="Loading connections…" />;

  const matching = (existing.data ?? []).filter((e) => e.connectionType === kind);

  if (!connection) {
    return (
      <div className="space-y-4">
        <Callout tone="warning" title={`${connector.name} is not certified`}>
          {connector.caveat}
        </Callout>
        {matching.length > 0 && (
          <>
            <p className="text-sm text-slate-600">Use a connection you already have.</p>
            <ul className="space-y-2">
              {matching.map((environment) => (
                <li key={environment.id}>
                  <button
                    type="button"
                    data-testid={`choose-connection-${environment.id}`}
                    onClick={() => setConnection(environment)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3 text-left hover:border-brand-300 hover:bg-brand-50/30"
                  >
                    <span className="text-sm font-medium text-slate-900">{environment.displayName}</span>
                    <span className="text-xs font-medium text-brand-700">Browse content</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {connect.error && <ErrorState error={connect.error} />}
        <Button
          variant={matching.length ? 'secondary' : 'primary'}
          loading={connect.isPending}
          onClick={() => connect.mutate()}
          data-testid="new-connection"
        >
          Connect to {connector.name}
        </Button>
        {/*
          The distinction the whole invariant rests on, said before anybody relies on the opposite.
        */}
        <p className="text-xs text-slate-500">
          Connecting does not add any data. You choose what to work with next, and that is what becomes a
          dataset.
        </p>
      </div>
    );
  }

  if (kind === 'SHAREPOINT' && !site) {
    return <ChooseSite connection={connection} onBack={() => setConnection(null)} onChoose={setSite} />;
  }

  return (
    <ChooseMicrosoftContent
      project={project}
      connection={connection}
      site={site}
      onBack={() => (site ? setSite(null) : setConnection(null))}
      onDone={onDone}
    />
  );
}

/** Which SharePoint site. Searchable, because a tenant can have thousands. */
function ChooseSite({
  connection,
  onBack,
  onChoose,
}: {
  connection: EnvironmentDto;
  onBack: () => void;
  onChoose: (site: GraphSite) => void;
}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const sites = useQuery({
    queryKey: ['sharepoint-sites', connection.id, search],
    queryFn: () =>
      api<GraphSite[]>(
        'GET',
        `/api/staged-sources/${connection.id}/sites${search ? `?q=${encodeURIComponent(search)}` : ''}`,
      ),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-900">Choose a SharePoint site</h3>
        <Button size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>

      <form
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query.trim());
        }}
      >
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sites"
          aria-label="Search sites"
          data-testid="site-search"
          className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </form>

      {sites.isLoading && <Spinner label="Asking SharePoint which sites you can see…" />}
      {sites.error && <ErrorState error={sites.error} />}
      {sites.data?.length === 0 && (
        <p className="py-6 text-center text-sm text-slate-500">No sites matched.</p>
      )}
      <ul className="space-y-2">
        {(sites.data ?? []).map((site) => (
          <li key={site.id}>
            <button
              type="button"
              data-testid={`site-${site.id}`}
              onClick={() => onChoose(site)}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3 text-left hover:border-brand-300 hover:bg-brand-50/30"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-900">{site.displayName}</span>
                <span className="block truncate text-xs text-slate-500">{site.webUrl}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The content itself: a list, or a file in a library.
 *
 * Both end as a dataset; neither the site nor the connection ever does. Lists are offered first because a
 * list *is* a table, and a file has to be read before anybody knows what is in it.
 */
function ChooseMicrosoftContent({
  project,
  connection,
  site,
  onBack,
  onDone,
}: {
  project: ProjectDto;
  connection: EnvironmentDto;
  site: GraphSite | null;
  onBack: () => void;
  onDone: () => void;
}) {
  const [folder, setFolder] = useState<{ id: string | null; name: string }[]>([{ id: null, name: 'Files' }]);
  const queryClient = useQueryClient();
  const here = folder[folder.length - 1]!;

  const lists = useQuery({
    queryKey: ['sharepoint-lists', connection.id, site?.id],
    queryFn: () => api<GraphList[]>('GET', `/api/staged-sources/${connection.id}/sites/${site!.id}/lists`),
    enabled: Boolean(site),
  });

  const files = useQuery({
    queryKey: ['microsoft-files', connection.id, site?.id, here.id],
    queryFn: () =>
      api<GraphDriveItem[]>(
        'GET',
        `/api/staged-sources/${connection.id}/files?${new URLSearchParams({
          ...(site ? { siteId: site.id } : {}),
          ...(here.id ? { parentId: here.id } : {}),
        }).toString()}`,
      ),
  });

  const added = async () => {
    await queryClient.invalidateQueries({ queryKey: ['assessment', project.id] });
    await queryClient.invalidateQueries({ queryKey: ['project', project.id] });
    onDone();
  };

  const addList = useMutation({
    mutationFn: async (list: GraphList) => {
      await api('POST', `/api/staged-sources/${connection.id}/import-sharepoint-list`, {
        reference: `sites/${site!.id}/lists/${list.id}`,
      });
      await api('POST', `/api/projects/${project.id}/sources`, { environmentId: connection.id });
    },
    onSuccess: added,
  });

  const addFile = useMutation({
    mutationFn: async (item: GraphDriveItem) => {
      await api('POST', `/api/staged-sources/${connection.id}/import-onedrive`, {
        reference: item.reference,
      });
      await api('POST', `/api/projects/${project.id}/sources`, { environmentId: connection.id });
    },
    onSuccess: added,
  });

  const busy = addList.isPending || addFile.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Choose data</h3>
          <p className="text-xs text-slate-500">{site ? site.displayName : connection.displayName}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>

      {(addList.error || addFile.error) && <ErrorState error={addList.error ?? addFile.error!} />}

      {site && (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Lists</h4>
          {lists.isLoading && <Spinner label="Reading the site…" />}
          {lists.error && <ErrorState error={lists.error} />}
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {(lists.data ?? [])
              .filter((list) => list.template !== 'documentLibrary')
              .map((list) => (
                <li key={list.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-900">{list.displayName}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    data-testid={`add-list-${list.id}`}
                    onClick={() => addList.mutate(list)}
                  >
                    Add dataset
                  </Button>
                </li>
              ))}
            {lists.data?.filter((l) => l.template !== 'documentLibrary').length === 0 && (
              <li className="px-3 py-3 text-sm text-slate-500">This site has no lists you can read.</li>
            )}
          </ul>
        </section>
      )}

      <section>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {site ? 'Documents' : 'Files'}
        </h4>
        {/* Where you are, and the way back out of it. */}
        <p className="mb-1 text-xs text-slate-500">
          {folder.map((step, i) => (
            <span key={`${step.id ?? 'root'}-${i}`}>
              {i > 0 && ' / '}
              <button
                type="button"
                className="hover:underline"
                onClick={() => setFolder((f) => f.slice(0, i + 1))}
              >
                {step.name}
              </button>
            </span>
          ))}
        </p>
        {files.isLoading && <Spinner label="Reading the folder…" />}
        {files.error && <ErrorState error={files.error} />}
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {(files.data ?? []).map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-3 py-2">
              <span className="flex-none text-slate-400">
                {item.isFolder ? <Database className="h-4 w-4" /> : <FileSpreadsheet className="h-4 w-4" />}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-900">{item.name}</span>
              {item.isFolder ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setFolder((f) => [...f, { id: item.id, name: item.name }])}
                >
                  Open
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  data-testid={`add-file-${item.id}`}
                  onClick={() => addFile.mutate(item)}
                >
                  Add dataset
                </Button>
              )}
            </li>
          ))}
          {files.data?.length === 0 && (
            <li className="px-3 py-3 text-sm text-slate-500">Nothing in this folder.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
