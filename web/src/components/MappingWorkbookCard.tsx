import type { MappingImportPreviewDto, MigrationPlanDto } from '@shared/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { post } from '../lib/api';
import { fmtNumber } from '../lib/format';
import { Button, Callout, Card, ErrorState, ExportButton, Pill, Table, Td, Th } from './ui';

/**
 * The mapping workbook, on the plan it belongs to.
 *
 * Download it, send it to whoever knows what the legacy columns mean, get it back, and see exactly
 * what it would change before anything changes. The preview is not politeness — a mapping sheet
 * arrives by email, and nobody should learn what was in it by watching it take effect.
 */
export function MappingWorkbookCard({ plan }: { plan: MigrationPlanDto }) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [preview, setPreview] = useState<MappingImportPreviewDto | null>(null);

  const run = useMutation({
    mutationFn: async (apply: boolean) =>
      post<MappingImportPreviewDto>(`/api/plans/${plan.id}/mapping-workbook`, {
        filename: file!.name,
        contentBase64: file!.base64,
        apply,
      }),
    onSuccess: (result) => {
      setPreview(result);
      if (result.applied) {
        void qc.invalidateQueries({ queryKey: ['plan', plan.id] });
        void qc.invalidateQueries({ queryKey: ['mappings'] });
      }
    },
  });

  const choose = async (chosen: File | undefined) => {
    setPreview(null);
    if (!chosen) return setFile(null);
    const buffer = await chosen.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    setFile({ name: chosen.name, base64: btoa(binary) });
  };

  const changes = (preview?.changes ?? []).filter((c) => c.action !== 'UNCHANGED');

  return (
    <Card
      title="Mapping workbook"
      subtitle="The mapping as a spreadsheet, for the people who know the source but will never open this tool."
      data-testid="mapping-workbook"
      actions={
        <ExportButton href={`/api/plans/${plan.id}/mapping.xlsx`} label="Download workbook" size="md" />
      }
    >
      <p className="text-sm text-slate-600">
        The workbook lists every source column with what was measured in it — record counts, nulls, blanks,
        distinct values, a sample — next to the target columns to decide.
        {plan.projectName
          ? ''
          : ' Link this plan to a project with an analysis and those figures fill in automatically.'}
      </p>

      <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <FileSpreadsheet className="h-5 w-5 text-slate-400" />
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.csv"
            data-testid="workbook-file"
            className="text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
            onChange={(e) => void choose(e.target.files?.[0])}
          />
          <Button
            size="sm"
            icon={<Upload className="h-3.5 w-3.5" />}
            disabled={!file}
            loading={run.isPending && !run.variables}
            data-testid="preview-workbook"
            onClick={() => run.mutate(false)}
          >
            Check what it would change
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          An .xlsx from the download above, or a CSV with the same column headings. Nothing is applied until
          you say so.
        </p>
      </div>

      {run.error && <ErrorState error={run.error} />}

      {preview && (
        <div className="mt-4 space-y-3" data-testid="workbook-preview">
          <div className="flex flex-wrap gap-2 text-xs">
            <Pill tone="blue">{fmtNumber(preview.matched)} row(s) matched</Pill>
            <Pill tone={changes.length ? 'violet' : 'slate'}>{fmtNumber(changes.length)} change(s)</Pill>
            {preview.unmatched.length > 0 && (
              <Pill tone="amber">{fmtNumber(preview.unmatched.length)} not in this plan</Pill>
            )}
            {preview.rejected.length > 0 && (
              <Pill tone="red">{fmtNumber(preview.rejected.length)} refused</Pill>
            )}
            {preview.applied && <Pill tone="teal">applied</Pill>}
          </div>

          {changes.length === 0 && !preview.applied && (
            <p className="text-sm text-slate-600">
              This workbook matches the plan as it already is. Nothing to apply.
            </p>
          )}

          {changes.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Table</Th>
                  <Th>Source column</Th>
                  <Th>Currently</Th>
                  <Th>Becomes</Th>
                  <Th>Action</Th>
                </tr>
              </thead>
              <tbody>
                {changes.slice(0, 100).map((c, i) => (
                  <tr key={`${c.table}-${c.field}-${i}`}>
                    <Td className="font-mono text-xs">{c.table}</Td>
                    <Td className="font-mono text-xs">{c.field}</Td>
                    <Td className="text-xs text-slate-500">{c.from ?? '—'}</Td>
                    <Td className="text-xs font-medium text-slate-800">{c.to ?? '—'}</Td>
                    <Td>
                      <Pill tone={c.action === 'IGNORE' ? 'slate' : 'violet'}>{c.action.toLowerCase()}</Pill>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {changes.length > 100 && (
            <p className="text-xs text-slate-500">Showing the first 100 of {fmtNumber(changes.length)}.</p>
          )}

          {preview.rejected.length > 0 && (
            <Callout tone="warning" title={`${preview.rejected.length} row(s) were refused`}>
              <ul className="mt-1 space-y-0.5 text-xs">
                {preview.rejected.slice(0, 20).map((r, i) => (
                  <li key={i}>
                    Row {r.row} —{' '}
                    <code className="font-mono">
                      {r.table}.{r.field}
                    </code>
                    : {r.reason}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          {preview.unmatched.length > 0 && (
            <Callout tone="info" title={`${preview.unmatched.length} row(s) are not in this plan`}>
              <ul className="mt-1 space-y-0.5 text-xs">
                {preview.unmatched.slice(0, 20).map((r, i) => (
                  <li key={i}>
                    Row {r.row} —{' '}
                    <code className="font-mono">
                      {r.table}.{r.field}
                    </code>
                    : {r.reason}
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          {!preview.applied && changes.length > 0 && (
            <Button
              variant="primary"
              loading={run.isPending}
              data-testid="apply-workbook"
              onClick={() => run.mutate(true)}
            >
              Apply {changes.length} change{changes.length === 1 ? '' : 's'}
            </Button>
          )}
          {preview.applied && (
            <p className="text-sm text-emerald-700">
              Applied. The plan was re-validated, so any new issue is already on the review step.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
