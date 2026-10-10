import type {
  ComparisonDifferenceDto,
  ComparisonDifferenceType,
  DataComparisonDto,
  DataComparisonTableResultDto,
} from '@shared/domain';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, CheckCircle2, Scale } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Callout,
  Card,
  Disclosure,
  EmptyState,
  ErrorState,
  ExportButton,
  PageHeader,
  Pill,
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../components/ui';
import { get } from '../lib/api';
import { fmtDate, fmtNumber } from '../lib/format';

const POLL_MS = 2000;

const TYPE_LABELS: Record<ComparisonDifferenceType, string> = {
  VALUE_DIFFERS: 'Value differs',
  ONLY_IN_LEFT: 'Only on side A',
  ONLY_IN_RIGHT: 'Only on side B',
  DUPLICATE_KEY: 'Duplicate key',
  BLANK_KEY: 'No key',
};

/**
 * The result of a reconciliation.
 *
 * The tiles are the answer most people came for, so they are first and they are complete counts.
 * Everything that qualifies those counts — a capped read, a key that identified nothing, columns
 * that exist on one side only — is stated on the same screen rather than left for somebody to
 * discover later.
 */
export function ComparisonPage() {
  const { comparisonId = '' } = useParams();
  const [table, setTable] = useState<string>('');
  const [type, setType] = useState<ComparisonDifferenceType | ''>('');

  const run = useQuery({
    queryKey: ['data-comparison', comparisonId],
    queryFn: () => get<DataComparisonDto>(`/api/data-comparisons/${comparisonId}`),
    refetchInterval: (q) =>
      q.state.data && (q.state.data.status === 'QUEUED' || q.state.data.status === 'RUNNING')
        ? POLL_MS
        : false,
  });

  const done = run.data?.status === 'COMPLETED';
  const differences = useQuery({
    queryKey: ['data-comparison-differences', comparisonId, table, type],
    queryFn: () =>
      get<{ rows: ComparisonDifferenceDto[]; total: number }>(
        `/api/data-comparisons/${comparisonId}/differences?limit=200${table ? `&table=${encodeURIComponent(table)}` : ''}${
          type ? `&type=${type}` : ''
        }`,
      ),
    enabled: done,
  });

  if (run.isLoading) return <Spinner label="Loading comparison…" />;
  if (run.error) return <ErrorState error={run.error} onRetry={() => run.refetch()} />;
  if (!run.data) return null;
  const c = run.data;
  const t = c.totals;
  const query = `${table ? `?table=${encodeURIComponent(table)}` : ''}${
    type ? `${table ? '&' : '?'}type=${type}` : ''
  }`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={c.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={done ? c.outcome : c.status} />
            <span className="flex items-center gap-1.5 text-slate-500">
              {c.leftEnvironment?.displayName ?? 'side A'}
              <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
              {c.rightEnvironment?.displayName ?? 'side B'}
            </span>
            <Pill tone="teal">read-only</Pill>
            <span className="text-slate-500">{fmtDate(c.createdAt)}</span>
          </span>
        }
        actions={
          <Link to={`/projects/${c.projectId}`} className="text-sm text-brand-700 hover:underline">
            Back to the project
          </Link>
        }
      />

      {(c.status === 'QUEUED' || c.status === 'RUNNING') && (
        <Callout tone="info" title="Comparing">
          {c.progressMessage ?? 'Reading both sides…'}
        </Callout>
      )}
      {c.status === 'FAILED' && (
        <Callout tone="danger" title="The comparison did not finish">
          {c.errorMessage ?? 'Unknown error'}
        </Callout>
      )}

      {done && (
        <>
          <div
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
            data-testid="comparison-totals"
          >
            <Stat label="Matched" value={fmtNumber(t.matched)} tone="green" />
            <Stat label="Different" value={fmtNumber(t.different)} tone={t.different ? 'red' : 'default'} />
            <Stat
              label="Only on A"
              value={fmtNumber(t.onlyInLeft)}
              tone={t.onlyInLeft ? 'amber' : 'default'}
            />
            <Stat
              label="Only on B"
              value={fmtNumber(t.onlyInRight)}
              tone={t.onlyInRight ? 'amber' : 'default'}
            />
            <Stat
              label="Field differences"
              value={fmtNumber(t.fieldDifferences)}
              tone={t.fieldDifferences ? 'red' : 'default'}
            />
            <Stat
              label="Not comparable"
              value={fmtNumber(t.duplicateKeys + t.blankKeys)}
              tone={t.duplicateKeys + t.blankKeys ? 'amber' : 'default'}
              hint="Records whose key is duplicated or empty"
            />
          </div>

          <p className="text-xs text-slate-500">
            {fmtNumber(t.leftRecords)} record(s) read from side A and {fmtNumber(t.rightRecords)} from side B.
            Every record read is counted in exactly one of the columns above.
          </p>

          <Card
            title="By table"
            subtitle="Each pair, with what agreed and what did not. Open a row for the checks and the columns that exist on one side only."
            actions={
              <ExportButton href={`/api/data-comparisons/${c.id}/summary.csv`} label="Summary (CSV)" />
            }
            data-testid="comparison-tables"
          >
            <Table>
              <thead>
                <tr>
                  <Th>Tables</Th>
                  <Th>Outcome</Th>
                  <Th className="text-right">A rows</Th>
                  <Th className="text-right">B rows</Th>
                  <Th className="text-right">Matched</Th>
                  <Th className="text-right">Different</Th>
                  <Th className="text-right">Only A</Th>
                  <Th className="text-right">Only B</Th>
                </tr>
              </thead>
              <tbody>
                {c.tables.map((row) => (
                  <TableRow key={row.leftTable} row={row} onFilter={() => setTable(row.leftTable)} />
                ))}
              </tbody>
            </Table>
          </Card>

          <Card
            title="Differences"
            subtitle="The record-by-record detail, keyed by the column you matched on."
            actions={
              <div className="flex items-center gap-2">
                <select
                  aria-label="Filter by table"
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  value={table}
                  onChange={(e) => setTable(e.target.value)}
                >
                  <option value="">All tables</option>
                  {c.tables.map((x) => (
                    <option key={x.leftTable} value={x.leftTable}>
                      {x.leftTable}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by difference"
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  value={type}
                  onChange={(e) => setType(e.target.value as ComparisonDifferenceType | '')}
                >
                  <option value="">Everything</option>
                  {Object.entries(TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <ExportButton href={`/api/data-comparisons/${c.id}/differences.csv${query}`} />
              </div>
            }
            bodyClassName="p-0"
            data-testid="comparison-differences"
          >
            {differences.isLoading && <Spinner />}
            {differences.error && (
              <div className="p-4">
                <ErrorState error={differences.error} />
              </div>
            )}
            {differences.data?.rows.length === 0 && (
              <EmptyState
                icon={<CheckCircle2 className="h-6 w-6" />}
                title="Nothing to show"
                description="No differences of this kind were found."
              />
            )}
            {(differences.data?.rows.length ?? 0) > 0 && (
              <>
                <Table>
                  <thead>
                    <tr>
                      <Th>Table</Th>
                      <Th>Key</Th>
                      <Th>Difference</Th>
                      <Th>Field</Th>
                      <Th>Side A</Th>
                      <Th>Side B</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {differences.data!.rows.map((d, i) => (
                      <tr key={`${d.leftTable}-${d.keyValue}-${d.field ?? ''}-${i}`}>
                        <Td className="text-xs text-slate-500">{d.leftTable}</Td>
                        <Td className="font-mono text-xs">{d.keyValue}</Td>
                        <Td>
                          <Pill tone={d.differenceType === 'VALUE_DIFFERS' ? 'red' : 'amber'}>
                            {TYPE_LABELS[d.differenceType]}
                          </Pill>
                        </Td>
                        <Td className="text-xs">{d.field ?? '—'}</Td>
                        <Td className="max-w-xs truncate text-xs">{d.leftValue ?? '—'}</Td>
                        <Td className="max-w-xs truncate text-xs">{d.rightValue ?? '—'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {differences.data!.total > differences.data!.rows.length && (
                  <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
                    Showing {fmtNumber(differences.data!.rows.length)} of {fmtNumber(differences.data!.total)}{' '}
                    stored differences. The counts above are complete; export for the rest.
                  </p>
                )}
              </>
            )}
          </Card>
        </>
      )}

      {done && c.tables.length === 0 && (
        <EmptyState
          icon={<Scale className="h-6 w-6" />}
          title="Nothing was compared"
          description="This comparison finished without a table result."
        />
      )}
    </div>
  );
}

function TableRow({ row, onFilter }: { row: DataComparisonTableResultDto; onFilter: () => void }) {
  return (
    <>
      <tr className="hover:bg-slate-50">
        <Td>
          <button type="button" onClick={onFilter} className="text-left font-medium text-brand-700">
            {row.leftTable} ↔ {row.rightTable}
          </button>
          {(row.leftTruncated || row.rightTruncated) && (
            <Pill tone="amber" title="Only part of the table was read">
              read capped
            </Pill>
          )}
        </Td>
        <Td>
          <StatusBadge status={row.outcome} />
        </Td>
        <Td className="text-right tabular-nums">{fmtNumber(row.leftCount ?? row.leftRecords)}</Td>
        <Td className="text-right tabular-nums">{fmtNumber(row.rightCount ?? row.rightRecords)}</Td>
        <Td className="text-right tabular-nums text-emerald-700">{fmtNumber(row.matched)}</Td>
        <Td className="text-right tabular-nums">{fmtNumber(row.different)}</Td>
        <Td className="text-right tabular-nums">{fmtNumber(row.onlyInLeft)}</Td>
        <Td className="text-right tabular-nums">{fmtNumber(row.onlyInRight)}</Td>
      </tr>
      <tr>
        <td colSpan={8} className="border-b border-slate-100 px-4 pb-3">
          <Disclosure summary={<span className="text-xs text-slate-500">Checks and columns</span>}>
            <ul className="space-y-1.5 text-xs">
              {row.checks.map((check, i) => (
                <li key={i} className="flex gap-2">
                  <StatusBadge status={check.outcome} />
                  <span className="text-slate-600">{check.message}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
              <div>
                <div className="font-medium text-slate-700">Compared ({row.comparedFields.length})</div>
                <div className="mt-1 text-slate-500">
                  {row.comparedFields.length
                    ? row.comparedFields.map((f) => f.left).join(', ')
                    : 'Keys only: existence, not content'}
                </div>
              </div>
              <div>
                <div className="font-medium text-slate-700">
                  Only on side A ({row.fieldsOnlyInLeft.length})
                </div>
                <div className="mt-1 text-slate-500">{row.fieldsOnlyInLeft.join(', ') || '—'}</div>
              </div>
              <div>
                <div className="font-medium text-slate-700">
                  Only on side B ({row.fieldsOnlyInRight.length})
                </div>
                <div className="mt-1 text-slate-500">{row.fieldsOnlyInRight.join(', ') || '—'}</div>
              </div>
            </div>
          </Disclosure>
        </td>
      </tr>
    </>
  );
}
