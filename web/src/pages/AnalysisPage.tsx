import type {
  AnalysisFindingDto,
  AnalysisRunDto,
  AnalysisTableDetailDto,
  FieldProfileDto,
} from '@shared/domain';
import { useQuery } from '@tanstack/react-query';
import { FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get } from '../lib/api';
import { fmtDate, fmtDuration, fmtNumber, pct } from '../lib/format';
import {
  Callout,
  Card,
  ErrorState,
  ExportButton,
  Mono,
  PageHeader,
  Pill,
  ProgressBar,
  SearchInput,
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Tabs,
  Td,
  Th,
} from '../components/ui';

type Tab = 'tables' | 'findings';

/**
 * What one analysis found.
 *
 * The screen is built around a question people actually have — "what is in there, and can I trust
 * these numbers" — so every count says whether it was measured exactly or estimated from a sample,
 * and the drill-down goes all the way to one column's real statistics.
 */
export function AnalysisPage() {
  const { analysisId = '' } = useParams();
  const [tab, setTab] = useState<Tab>('tables');
  const [openTable, setOpenTable] = useState<string | null>(null);

  const run = useQuery({
    queryKey: ['analysis', analysisId],
    queryFn: () => get<AnalysisRunDto>(`/api/analyses/${analysisId}`),
    refetchInterval: (query) =>
      query.state.data?.status === 'QUEUED' || query.state.data?.status === 'RUNNING' ? 2000 : false,
  });

  if (run.isLoading) return <Spinner label="Loading the analysis…" />;
  if (run.error) return <ErrorState error={run.error} onRetry={() => run.refetch()} />;
  if (!run.data) return null;
  const a = run.data;
  const running = a.status === 'QUEUED' || a.status === 'RUNNING';

  return (
    <div className="space-y-6">
      <PageHeader
        title={a.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={a.status} />
            <span className="text-slate-500">
              {a.environment.displayName} ·{' '}
              <Link to={`/projects/${a.projectId}`} className="text-brand-700 hover:underline">
                {a.projectName}
              </Link>
            </span>
            {a.completedAt && (
              <span className="text-slate-400">
                {fmtDate(a.completedAt)} · took {fmtDuration(a.startedAt ?? a.createdAt, a.completedAt)}
              </span>
            )}
          </span>
        }
        actions={
          a.status === 'COMPLETED' && (
            <div className="flex flex-wrap gap-2">
              <ExportButton href={`/api/analyses/${a.id}/mapping.xlsx`} label="Mapping workbook" size="md" />
              <ExportButton href={`/api/analyses/${a.id}/columns.csv`} label="Columns (CSV)" size="md" />
            </div>
          )
        }
      />

      {running && (
        <Card title="Reading the source">
          <Spinner label={a.progressMessage ?? 'Working…'} />
          <p className="mt-2 text-xs text-slate-500">
            Read-only. An analysis never writes to the system it is reading.
          </p>
        </Card>
      )}
      {a.status === 'FAILED' && (
        <Callout tone="danger" title="The analysis did not finish">
          {a.errorMessage ?? 'Unknown error.'}
        </Callout>
      )}

      {a.status === 'COMPLETED' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Tables" value={fmtNumber(a.totals.tables)} />
            <Stat label="Columns" value={fmtNumber(a.totals.columns)} />
            <Stat
              label="Records"
              value={`${fmtNumber(a.totals.records)}${a.totals.recordsApproximate ? '≈' : ''}`}
              hint={`${fmtNumber(a.totals.examined)} examined`}
            />
            <Stat
              label="Blockers"
              value={fmtNumber(a.totals.blockers)}
              tone={a.totals.blockers > 0 ? 'red' : 'green'}
            />
            <Stat
              label="Warnings"
              value={fmtNumber(a.totals.warnings)}
              tone={a.totals.warnings > 0 ? 'amber' : 'green'}
            />
            <Stat
              label="Empty columns"
              value={fmtNumber(a.totals.unusedColumns)}
              tone={a.totals.unusedColumns > 0 ? 'amber' : 'default'}
              hint={a.totals.emptyTables > 0 ? `${a.totals.emptyTables} empty table(s)` : undefined}
            />
          </div>

          <Callout
            tone={a.basis === 'EXACT' ? 'success' : 'warning'}
            title={a.basis === 'EXACT' ? 'These numbers are exact' : 'These numbers come from a sample'}
          >
            {a.basis === 'EXACT'
              ? 'Every record of every table was examined against an exact row count, so each count is a total rather than a floor.'
              : 'At least one table was sampled or could only report an estimated row count, so the counts are a floor. Re-run with “examine every record” for exact figures.'}
          </Callout>

          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'tables', label: `Tables (${a.totals.tables})` },
              { value: 'findings', label: `Findings (${a.totals.findings})` },
            ]}
          />

          {tab === 'tables' && <TablesTab run={a} openTable={openTable} onOpen={setOpenTable} />}
          {tab === 'findings' && <FindingsTab analysisId={a.id} />}
        </>
      )}
    </div>
  );
}

function TablesTab({
  run,
  openTable,
  onOpen,
}: {
  run: AnalysisRunDto;
  openTable: string | null;
  onOpen: (t: string | null) => void;
}) {
  return (
    <div className="space-y-4">
      <Card
        title="Tables"
        subtitle="In dependency-safe load order: a table appears after everything it points at."
        data-testid="analysis-tables"
        actions={<ExportButton href={`/api/analyses/${run.id}/tables.csv`} label="Export" />}
      >
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Table</Th>
              <Th className="text-right">Records</Th>
              <Th className="text-right">Columns</Th>
              <Th>Statistics</Th>
              <Th className="text-right">Findings</Th>
              <Th>Depends on</Th>
              <Th>Empty columns</Th>
            </tr>
          </thead>
          <tbody>
            {run.tables.map((t) => (
              <tr
                key={t.logicalName}
                className={`cursor-pointer hover:bg-slate-50 ${openTable === t.logicalName ? 'bg-brand-50' : ''}`}
                onClick={() => onOpen(openTable === t.logicalName ? null : t.logicalName)}
              >
                <Td className="tabular-nums text-slate-400">{t.orderIndex + 1}</Td>
                <Td>
                  <span className="font-medium text-slate-800">{t.displayName}</span>
                  <div className="font-mono text-xs text-slate-400">{t.logicalName}</div>
                </Td>
                <Td className="text-right tabular-nums">
                  {fmtNumber(t.recordCount)}
                  {t.recordCountApproximate && <span className="text-slate-400">≈</span>}
                </Td>
                <Td className="text-right tabular-nums">{t.columnCount}</Td>
                <Td>
                  <span className={t.basis === 'EXACT' ? 'text-emerald-700' : 'text-amber-700'}>
                    {t.basis === 'EXACT' ? 'exact' : `${fmtNumber(t.examined)} sampled`}
                  </span>
                </Td>
                <Td className="text-right">
                  {t.blockers > 0 && <Pill tone="red">{t.blockers}</Pill>}{' '}
                  {t.warnings > 0 && <Pill tone="amber">{t.warnings}</Pill>}
                  {t.blockers === 0 && t.warnings === 0 && <span className="text-slate-400">—</span>}
                </Td>
                <Td className="max-w-xs truncate text-xs text-slate-500">
                  {t.dependsOn.length ? t.dependsOn.join(', ') : '—'}
                </Td>
                <Td className="max-w-xs truncate text-xs text-amber-700">
                  {t.emptyColumns.length ? t.emptyColumns.join(', ') : ''}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="mt-2 text-xs text-slate-500">Select a table to see its columns.</p>
      </Card>

      {openTable && <TableDetail analysisId={run.id} logicalName={openTable} />}
    </div>
  );
}

function TableDetail({ analysisId, logicalName }: { analysisId: string; logicalName: string }) {
  const [search, setSearch] = useState('');
  const detail = useQuery({
    queryKey: ['analysis-table', analysisId, logicalName],
    queryFn: () =>
      get<AnalysisTableDetailDto>(`/api/analyses/${analysisId}/tables/${encodeURIComponent(logicalName)}`),
  });

  if (detail.isLoading) return <Spinner label={`Loading ${logicalName}…`} />;
  if (detail.error) return <ErrorState error={detail.error} />;
  if (!detail.data) return null;
  const d = detail.data;
  const q = search.trim().toLowerCase();
  const fields = q
    ? d.profile.fields.filter(
        (f) => f.field.toLowerCase().includes(q) || f.displayName.toLowerCase().includes(q),
      )
    : d.profile.fields;

  return (
    <Card
      title={`${d.displayName} — columns`}
      subtitle={
        <>
          <Mono>{d.logicalName}</Mono> · {fmtNumber(d.recordCount)} record(s), {fmtNumber(d.examined)}{' '}
          examined
          {d.primaryKeyField && (
            <>
              {' '}
              · key <Mono>{d.primaryKeyField}</Mono>
              {d.duplicateKeyCount > 0 && (
                <span className="text-red-700"> ({d.duplicateKeyCount} duplicate)</span>
              )}
            </>
          )}
        </>
      }
      data-testid="analysis-columns"
      actions={<SearchInput value={search} onChange={setSearch} placeholder="Filter columns…" />}
    >
      <Table>
        <thead>
          <tr>
            <Th>Column</Th>
            <Th>Type</Th>
            <Th className="text-right">Populated</Th>
            <Th className="text-right">Nulls</Th>
            <Th className="text-right">Blanks</Th>
            <Th className="text-right">Distinct</Th>
            <Th>Length</Th>
            <Th>Range</Th>
            <Th>Most common</Th>
            <Th className="text-right">Findings</Th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <FieldRow key={f.field} field={f} />
          ))}
        </tbody>
      </Table>
      {d.findings.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 text-sm font-medium text-slate-700">Findings in this table</h4>
          <FindingsTable findings={d.findings} showTable={false} />
        </div>
      )}
    </Card>
  );
}

function FieldRow({ field: f }: { field: FieldProfileDto }) {
  const populated = f.examined > 0 ? pct(f.examined - f.nullCount - f.blankCount, f.examined) : 0;
  const empty = f.examined > 0 && f.nullCount + f.blankCount >= f.examined;
  const top = f.topValues.find((v) => v.value !== null && v.value !== '');
  return (
    <tr className={empty ? 'bg-amber-50/40' : undefined}>
      <Td>
        <span className="font-medium text-slate-800">{f.displayName}</span>
        <div className="font-mono text-xs text-slate-400">{f.field}</div>
      </Td>
      <Td className="text-xs">{f.type}</Td>
      <Td className="w-28 text-right">
        <ProgressBar
          value={populated}
          tone={empty ? 'amber' : populated > 90 ? 'green' : 'brand'}
          label={`${populated}%`}
        />
      </Td>
      <Td className="text-right tabular-nums">{fmtNumber(f.nullCount)}</Td>
      <Td className="text-right tabular-nums">{fmtNumber(f.blankCount)}</Td>
      <Td className="text-right tabular-nums">
        {f.distinctCount === null ? '—' : fmtNumber(f.distinctCount)}
      </Td>
      <Td className="text-xs text-slate-600">
        {f.minLength === null ? '—' : `${f.minLength}–${f.maxLength}`}
      </Td>
      <Td className="text-xs text-slate-600">
        {f.minValue !== null
          ? `${fmtNumber(f.minValue)} – ${fmtNumber(f.maxValue)}`
          : f.minDate
            ? `${f.minDate.slice(0, 10)} – ${f.maxDate?.slice(0, 10)}`
            : '—'}
      </Td>
      <Td className="max-w-[14rem] truncate text-xs text-slate-500">
        {top ? `${top.value} (${fmtNumber(top.count)})` : '—'}
      </Td>
      <Td className="text-right">
        {f.issues.length === 0 ? (
          <span className="text-slate-400">—</span>
        ) : (
          <Pill tone={f.issues.some((i) => i.severity === 'BLOCKER') ? 'red' : 'amber'}>
            {f.issues.length}
          </Pill>
        )}
      </Td>
    </tr>
  );
}

function FindingsTab({ analysisId }: { analysisId: string }) {
  const [severity, setSeverity] = useState<'' | 'BLOCKER' | 'WARNING'>('');
  const findings = useQuery({
    queryKey: ['analysis-findings', analysisId, severity],
    queryFn: () =>
      get<AnalysisFindingDto[]>(
        `/api/analyses/${analysisId}/findings${severity ? `?severity=${severity}` : ''}`,
      ),
  });

  return (
    <Card
      title="Findings"
      subtitle="What the source contradicts about itself, measured against its own declared schema."
      data-testid="analysis-findings"
      actions={
        <div className="flex items-center gap-2">
          <Tabs
            value={severity}
            onChange={setSeverity}
            tabs={[
              { value: '' as const, label: 'All' },
              { value: 'BLOCKER' as const, label: 'Blockers' },
              { value: 'WARNING' as const, label: 'Warnings' },
            ]}
          />
          <ExportButton
            href={`/api/analyses/${analysisId}/findings.csv${severity ? `?severity=${severity}` : ''}`}
            label="Export"
          />
        </div>
      }
    >
      {findings.isLoading && <Spinner />}
      {findings.error && <ErrorState error={findings.error} />}
      {findings.data?.length === 0 && (
        <p className="text-sm text-emerald-700">Nothing found. The source agrees with its own schema.</p>
      )}
      {(findings.data?.length ?? 0) > 0 && <FindingsTable findings={findings.data!} showTable />}
    </Card>
  );
}

function FindingsTable({ findings, showTable }: { findings: AnalysisFindingDto[]; showTable: boolean }) {
  return (
    <Table>
      <thead>
        <tr>
          {showTable && <Th>Table</Th>}
          <Th>Column</Th>
          <Th>Severity</Th>
          <Th>Finding</Th>
          <Th className="text-right">Affected</Th>
          <Th>Statistics</Th>
          <Th>Suggested resolution</Th>
        </tr>
      </thead>
      <tbody>
        {findings.map((f, i) => (
          <tr key={`${f.table}-${f.field}-${f.code}-${i}`}>
            {showTable && <Td className="font-mono text-xs">{f.table}</Td>}
            <Td className="font-mono text-xs">{f.field ?? '—'}</Td>
            <Td>
              <Pill tone={f.severity === 'BLOCKER' ? 'red' : 'amber'}>{f.severity.toLowerCase()}</Pill>
            </Td>
            <Td className="text-xs text-slate-700">{f.message}</Td>
            <Td className="text-right tabular-nums">{fmtNumber(f.affected)}</Td>
            <Td className="text-xs">
              <span className={f.basis === 'EXACT' ? 'text-emerald-700' : 'text-amber-700'}>
                {f.basis === 'EXACT' ? 'exact' : 'sampled'}
              </span>
            </Td>
            <Td className="text-xs text-slate-500">{f.resolution ?? '—'}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Shown on a migration plan: the workbook is how the mapping leaves and re-enters the tool. */
export function MappingWorkbookLink({ planId }: { planId: string }) {
  return (
    <a
      href={`/api/plans/${planId}/mapping.xlsx`}
      download
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
    >
      <FileSpreadsheet className="h-3.5 w-3.5" />
      Mapping workbook
    </a>
  );
}
