import type { MigrationRunListItemDto } from '@shared/domain';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, History } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, EmptyState, ErrorState, PageHeader, Spinner, StatusBadge, Table, Tabs, Td, Th } from '../components/ui';
import { get } from '../lib/api';
import { fmtDate, fmtDuration, fmtNumber } from '../lib/format';
import type { ValidationListItem } from './ValidationPage';

export function RunsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'migration' | 'validation'>('migration');
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => get<MigrationRunListItemDto[]>('/api/runs'), refetchInterval: 5000 });
  const validations = useQuery({ queryKey: ['validations'], queryFn: () => get<ValidationListItem[]>('/api/validations'), refetchInterval: 5000 });
  return (
    <>
      <PageHeader title="Runs" description="Complete, persisted history of migration and validation runs in your organization." />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'migration', label: `Migration runs${runs.data ? ` (${runs.data.length})` : ''}` },
            { value: 'validation', label: `Validation runs${validations.data ? ` (${validations.data.length})` : ''}` },
          ]}
        />
      </div>
      {tab === 'migration' && (
        <Card bodyClassName="p-0">
          {runs.isLoading && <Spinner />}
          {runs.error && <div className="p-4"><ErrorState error={runs.error} /></div>}
          {runs.data?.length === 0 && <EmptyState icon={<History className="h-8 w-8" />} title="No migration runs yet" />}
          {runs.data && runs.data.length > 0 && (
            <Table>
              <thead className="bg-slate-50">
                <tr>
                  <Th>Plan</Th>
                  <Th>Source → Target</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Processed</Th>
                  <Th className="text-right">Failed</Th>
                  <Th>Started</Th>
                  <Th>Duration</Th>
                  <Th>By</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {runs.data.map((r) => (
                  <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/runs/${r.id}`)} data-testid="run-row">
                    <Td className="font-medium text-slate-900">{r.planName}</Td>
                    <Td>
                      {r.sourceEnvironment.displayName} <ArrowRight className="inline h-3 w-3" /> {r.targetEnvironment.displayName}
                    </Td>
                    <Td><StatusBadge status={r.status} /></Td>
                    <Td className="text-right tabular-nums">
                      {fmtNumber(r.processed)} / {fmtNumber(r.total)}
                    </Td>
                    <Td className={`text-right tabular-nums ${r.failed ? 'text-red-700' : ''}`}>{fmtNumber(r.failed)}</Td>
                    <Td className="whitespace-nowrap text-slate-500">{fmtDate(r.createdAt)}</Td>
                    <Td className="text-slate-500">{fmtDuration(r.createdAt, r.completedAt)}</Td>
                    <Td className="text-slate-500">{r.createdBy ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      {tab === 'validation' && (
        <Card bodyClassName="p-0">
          {validations.isLoading && <Spinner />}
          {validations.error && <div className="p-4"><ErrorState error={validations.error} /></div>}
          {validations.data?.length === 0 && <EmptyState title="No validation runs yet" />}
          {validations.data && validations.data.length > 0 && <ValidationTable items={validations.data} onOpen={(id) => navigate(`/validation/${id}`)} />}
        </Card>
      )}
    </>
  );
}

export function ValidationTable({ items, onOpen }: { items: ValidationListItem[]; onOpen: (id: string) => void }) {
  return (
    <Table>
      <thead className="bg-slate-50">
        <tr>
          <Th>Source → Target</Th>
          <Th>Status</Th>
          <Th>Outcome</Th>
          <Th className="text-right">Tables</Th>
          <Th className="text-right">Missing</Th>
          <Th className="text-right">Different</Th>
          <Th>Scope</Th>
          <Th>Started</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {items.map((v) => (
          <tr key={v.id} className="cursor-pointer hover:bg-slate-50" onClick={() => onOpen(v.id)} data-testid="validation-row">
            <Td>
              {v.sourceEnvironment.displayName} <ArrowRight className="inline h-3 w-3" /> {v.targetEnvironment.displayName}
            </Td>
            <Td><StatusBadge status={v.status} /></Td>
            <Td><StatusBadge status={v.outcome} /></Td>
            <Td className="text-right tabular-nums">{v.tableCount}</Td>
            <Td className="text-right tabular-nums">{fmtNumber(v.summary?.missingRecords)}</Td>
            <Td className="text-right tabular-nums">{fmtNumber(v.summary?.differentRecords)}</Td>
            <Td className="text-xs text-slate-500">{v.migrationRunId ? 'Migration run' : 'Environment tables'}</Td>
            <Td className="whitespace-nowrap text-slate-500">{fmtDate(v.createdAt)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
