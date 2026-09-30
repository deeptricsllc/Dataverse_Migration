import {
  CONNECTION_TYPE_LABELS,
  STAGED_SOURCE_LABELS,
  type EnvironmentDto,
  type StagedImportResultDto,
  type StagedTableDto,
} from '@shared/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { StagedFileImport } from './StagedFileImport';
import { api, get, post } from '../lib/api';
import { fmtNumber, fmtRelative } from '../lib/format';
import { Button, Card, Disclosure, ErrorState, Pill, Spinner, Table, Td, Th } from './ui';

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

  /** The Graph import reports its own result; a file upload reports through StagedFileImport. */
  const [referenceResult, setReferenceResult] = useState<StagedImportResultDto | null>(null);

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
      setReferenceResult(result);
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
          {referenceResult && (
            <p className="mt-2 text-sm text-emerald-700" data-testid="staged-import-result">
              Imported {referenceResult.tables.length} table(s), {fmtNumber(referenceResult.totalRows)}{' '}
              row(s).
            </p>
          )}
        </div>
      )}

      <StagedFileImport
        environment={environment}
        prompt={
          justCreated
            ? 'Connection created. Choose the file to import — it stays on this connection and you can add more later.'
            : undefined
        }
      />

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
