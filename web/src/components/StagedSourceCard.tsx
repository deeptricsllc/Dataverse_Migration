import {
  CONNECTION_TYPE_LABELS,
  STAGED_SOURCE_LABELS,
  type EnvironmentDto,
  type StagedImportResultDto,
  type StagedTableDto,
} from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, get, post } from '../lib/api';
import { fmtNumber, fmtRelative } from '../lib/format';
import { Button, Callout, Card, cx, Disclosure, ErrorState, Pill, Spinner, Table, Td, Th } from './ui';

/**
 * The imported tables belonging to a file source, and how to add more.
 *
 * The inferred type of every column is shown with the reason it was chosen, because a schema that
 * was guessed should be inspectable. Somebody who sees "kept as text — the day and month order is
 * ambiguous" knows what to do about it; somebody who just sees "text" does not.
 */
export function StagedSourceCard({
  environment,
  justCreated = false,
  isSource = false,
  onSetSource,
}: {
  environment: EnvironmentDto;
  /** Just created from the Add connection dialog, so it says what to do rather than sitting empty. */
  justCreated?: boolean;
  /** Already chosen as the workspace source. */
  isSource?: boolean;
  /**
   * Choose this file source as the source to work from.
   *
   * It lives here because a file source now has exactly one card. It used to have two — this one,
   * and an ordinary connection card whose every row was "—" but which carried this button.
   */
  onSetSource?: () => void;
}) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [lastImport, setLastImport] = useState<StagedImportResultDto | null>(null);
  const [reference, setReference] = useState('');
  const kind = environment.connectionType;
  const fromGraph = kind === 'ONEDRIVE' || kind === 'SHAREPOINT';

  const tables = useQuery({
    queryKey: ['staged-tables', environment.id],
    queryFn: () => get<StagedTableDto[]>(`/api/staged-sources/${environment.id}/tables`),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['staged-tables', environment.id] });
    void qc.invalidateQueries({ queryKey: ['environments'] });
  };

  const importFile = useMutation({
    mutationFn: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      return post<StagedImportResultDto>(`/api/staged-sources/${environment.id}/import`, {
        filename: file.name,
        contentBase64: btoa(binary),
      });
    },
    onSuccess: (result) => {
      setLastImport(result);
      invalidate();
      if (fileInput.current) fileInput.current.value = '';
    },
  });

  /** OneDrive and SharePoint are fetched with the signed-in user's own account, not a stored secret. */
  const importReference = useMutation({
    mutationFn: () =>
      post<StagedImportResultDto>(
        `/api/staged-sources/${environment.id}/${
          kind === 'SHAREPOINT' ? 'import-sharepoint-list' : 'import-onedrive'
        }`,
        { reference: reference.trim() },
      ),
    onSuccess: (result) => {
      setLastImport(result);
      invalidate();
      setReference('');
    },
  });

  const remove = useMutation({
    mutationFn: (logicalName: string) =>
      api<void>('DELETE', `/api/staged-sources/${environment.id}/tables/${encodeURIComponent(logicalName)}`),
    onSuccess: invalidate,
  });

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {environment.displayName}
          <Pill tone="slate">{CONNECTION_TYPE_LABELS[environment.connectionType]}</Pill>
        </span>
      }
      subtitle="A file has no server to query, so its rows are read once and kept here. Re-importing a file replaces it."
      data-testid={`staged-source-${environment.id}`}
      actions={
        onSetSource ? (
          <Button
            size="sm"
            variant={isSource ? 'primary' : 'secondary'}
            disabled={isSource}
            onClick={onSetSource}
            data-testid={`staged-set-source-${environment.id}`}
          >
            {isSource ? 'Source' : 'Set as source'}
          </Button>
        ) : undefined
      }
    >
      {fromGraph && (
        <div className="mb-3 rounded-lg border border-dashed border-slate-300 p-4">
          <label
            className="mb-1.5 block text-sm font-medium text-slate-700"
            htmlFor={`ref-${environment.id}`}
          >
            {kind === 'SHAREPOINT' ? 'SharePoint list' : 'OneDrive or SharePoint file'}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={`ref-${environment.id}`}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={
                kind === 'SHAREPOINT'
                  ? 'sites/{site-id}/lists/{list-id}'
                  : 'Paste the sharing link, or drives/{drive-id}/items/{item-id}'
              }
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <Button
              icon={<Upload className="h-3.5 w-3.5" />}
              disabled={!reference.trim()}
              loading={importReference.isPending}
              data-testid="import-reference"
              onClick={() => importReference.mutate()}
            >
              Import
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {kind === 'SHAREPOINT'
              ? 'A list is read with your own account. Its column types are ignored in favour of what the values actually are, the same as for a spreadsheet.'
              : 'The file is read with your own account, so you can only import what you can already open. Nothing is stored except the rows and where they came from.'}
          </p>
          {importReference.error && <ErrorState error={importReference.error} />}
        </div>
      )}

      {/*
        Just created from the Add connection dialog: the source exists and holds nothing, so the
        next step is named here rather than left to be worked out.
      */}
      <div
        className={cx(
          'rounded-lg border border-dashed p-4',
          justCreated ? 'border-brand-400 bg-brand-50' : 'border-slate-300',
        )}
      >
        {justCreated && (
          <p className="mb-3 text-sm font-medium text-brand-900">
            Connection created. Choose the file to import — it stays on this connection and you can add more
            later.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <FileSpreadsheet className="h-5 w-5 text-slate-400" />
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xml"
            data-testid="staged-file"
            className="text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importFile.mutate(file);
            }}
          />
          {importFile.isPending && <Spinner label="Reading the file…" />}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          A CSV (comma, semicolon or tab separated), an .xlsx workbook, or an XML export. Each sheet becomes a
          table; in XML the element that repeats becomes the rows, with attributes and nested values as
          columns. Column types are inferred from the values and shown below with the reasoning.
        </p>
      </div>

      {importFile.error && <ErrorState error={importFile.error} />}

      {lastImport && (
        <div className="mt-3 space-y-2" data-testid="staged-import-result">
          <p className="text-sm text-emerald-700">
            Imported {lastImport.tables.length} table(s), {fmtNumber(lastImport.totalRows)} row(s).
          </p>
          {lastImport.replaced.length > 0 && (
            <Callout
              // Re-importing the same file is ordinary. Rows arriving from a file with a different
              // name means two files resolved to one table, and the earlier one's rows are gone.
              tone={
                lastImport.replaced.some((r) => r.previousSourceRef !== lastImport.tables[0]?.sourceRef)
                  ? 'warning'
                  : 'info'
              }
              title={`${lastImport.replaced.length} table(s) replaced`}
            >
              <ul className="mt-1 space-y-0.5 text-xs">
                {lastImport.replaced.map((r) => (
                  <li key={r.logicalName}>
                    <span className="font-medium">{r.displayName}</span> held {fmtNumber(r.previousRows)}{' '}
                    row(s) from <span className="font-medium">{r.previousSourceRef}</span>
                    {r.previousSourceRef === lastImport.tables[0]?.sourceRef
                      ? '. A file is a snapshot, so those rows were replaced rather than added to.'
                      : ', a different file. Both files resolve to the same table name, so those rows have been replaced.'}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          {lastImport.skipped.length > 0 && (
            <Callout tone="info" title={`${lastImport.skipped.length} sheet(s) skipped`}>
              <ul className="mt-1 space-y-0.5 text-xs">
                {lastImport.skipped.map((s) => (
                  <li key={s.name}>
                    <span className="font-medium">{s.name}</span> — {s.reason}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
        </div>
      )}

      {tables.isLoading && <Spinner label="Loading imported tables…" />}
      {tables.error && <ErrorState error={tables.error} />}
      {tables.data?.length === 0 && (
        <p className="mt-3 text-sm text-slate-500">
          Nothing imported yet. This source has no tables until a file is uploaded.
        </p>
      )}

      {(tables.data?.length ?? 0) > 0 && (
        <div className="mt-4 space-y-3">
          {tables.data!.map((table) => (
            <div key={table.logicalName} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-slate-800">
                    {table.displayName}{' '}
                    <span className="font-mono text-xs text-slate-400">{table.logicalName}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {fmtNumber(table.rowCount)} row(s) · {table.columnCount} column(s) ·{' '}
                    {STAGED_SOURCE_LABELS[table.kind]} · from{' '}
                    <span className="font-mono">{table.sourceRef}</span>
                    {table.sheetName && (
                      <> ({table.sheetName.startsWith('<') ? table.sheetName : `sheet ${table.sheetName}`})</>
                    )}{' '}
                    · imported {fmtRelative(table.importedAt)}
                    {table.importedBy ? ` by ${table.importedBy}` : ''}
                  </p>
                  <p className="mt-1 text-xs">
                    {table.keyIsSynthetic ? (
                      <Pill tone="amber">no key column — rows identified by position</Pill>
                    ) : (
                      <Pill tone="teal">key: {table.keyColumn}</Pill>
                    )}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  loading={remove.isPending}
                  aria-label={`Remove ${table.displayName}`}
                  onClick={() => remove.mutate(table.logicalName)}
                />
              </div>

              {table.keyIsSynthetic && (
                <p className="mt-2 text-xs text-amber-800">
                  No column in this file is unique, always populated and named like a key, so rows are
                  identified by their position. That is enough to analyse the data, but a migration matching
                  on it cannot survive the file being re-exported in a different order.
                </p>
              )}

              <div className="mt-2">
                <Disclosure summary={`Columns (${table.columnCount})`}>
                  <Table>
                    <thead>
                      <tr>
                        <Th>Column</Th>
                        <Th>Inferred type</Th>
                        <Th className="text-right">Max length</Th>
                        <Th className="text-right">Blanks</Th>
                        <Th className="text-right">Distinct</Th>
                        <Th>Why this type</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.columns.map((column) => (
                        <tr
                          key={column.name}
                          className={column.blanks >= table.rowCount ? 'bg-amber-50/40' : undefined}
                        >
                          <Td className="font-mono text-xs">
                            {column.name}
                            {column.name === table.keyColumn && (
                              <span className="ml-1 text-teal-700">(key)</span>
                            )}
                          </Td>
                          <Td className="text-xs">{column.type}</Td>
                          <Td className="text-right tabular-nums text-xs">{column.maxLength ?? '—'}</Td>
                          <Td className="text-right tabular-nums text-xs">{fmtNumber(column.blanks)}</Td>
                          <Td className="text-right tabular-nums text-xs">
                            {column.distinct === null ? '—' : fmtNumber(column.distinct)}
                          </Td>
                          <Td className="text-xs text-slate-500">{column.reason}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Disclosure>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
        <Upload className="h-3.5 w-3.5" />
        Read-only. An imported source can be analysed and migrated <em>from</em>, never written to.
      </p>
    </Card>
  );
}
