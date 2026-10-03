import type { EnvironmentDto, StagedImportResultDto } from '@shared/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet } from 'lucide-react';
import { useRef, useState } from 'react';
import { post } from '../lib/api';
import { fmtNumber } from '../lib/format';
import { Callout, cx, ErrorState, Spinner } from './ui';

/**
 * Choosing a file and importing it.
 *
 * Extracted because a file source is useless until it holds a file, and there are now two moments
 * where somebody needs to supply one: on the connections page, and in the middle of creating a
 * project, where sending them to another page to do it would throw away the form they had started.
 * One component, so those two moments cannot drift apart.
 */
export function StagedFileImport({
  environment,
  prompt,
  onImported,
}: {
  environment: EnvironmentDto;
  /** Shown above the control when the source has just been created and holds nothing. */
  prompt?: string;
  onImported?: (result: StagedImportResultDto) => void;
}) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [lastImport, setLastImport] = useState<StagedImportResultDto | null>(null);

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
      void qc.invalidateQueries({ queryKey: ['staged-tables', environment.id] });
      void qc.invalidateQueries({ queryKey: ['environments'] });
      if (fileInput.current) fileInput.current.value = '';
      onImported?.(result);
    },
  });

  return (
    <div className="space-y-3">
      <div
        className={cx(
          'rounded-lg border border-dashed p-4',
          prompt ? 'border-brand-400 bg-brand-50' : 'border-slate-300',
        )}
      >
        {prompt && <p className="mb-3 text-sm font-medium text-brand-900">{prompt}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <FileSpreadsheet className="h-5 w-5 flex-none text-slate-400" aria-hidden />
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
          columns. Column types are inferred from the values, with the reasoning shown.
        </p>
      </div>

      {importFile.error && <ErrorState error={importFile.error} />}

      {lastImport && (
        <div className="space-y-2" data-testid="staged-import-result">
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
    </div>
  );
}
