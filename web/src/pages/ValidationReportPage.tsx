import type { DifferenceType, ValidationDifferenceDto, ValidationRunDto } from '@shared/domain';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WizardSteps } from '../components/WizardSteps';
import {
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  Mono,
  PageHeader,
  Select,
  Spinner,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../components/ui';
import { get, qs } from '../lib/api';
import { fmtDate, fmtNumber, humanize } from '../lib/format';
import { Pager } from './RunDetailPage';

const PAGE = 50;

export function ValidationReportPage() {
  const { validationId } = useParams();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [entity, setEntity] = useState('');
  const [type, setType] = useState('');
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(0);
  const run = useQuery({
    queryKey: ['validation', validationId],
    queryFn: () => get<ValidationRunDto>(`/api/validations/${validationId}`),
    refetchInterval: (q) =>
      q.state.data && ['QUEUED', 'RUNNING'].includes(q.state.data.status) ? 1000 : false,
  });
  const done = run.data?.status === 'COMPLETED';
  const diffs = useQuery({
    queryKey: ['validation-diffs', validationId, entity, type, outcome, page],
    queryFn: () =>
      get<{ items: ValidationDifferenceDto[]; total: number }>(
        `/api/validations/${validationId}/differences${qs({ entity: entity || undefined, type: type || undefined, outcome: outcome || undefined, limit: PAGE, offset: page * PAGE })}`,
      ),
    enabled: done,
  });

  if (run.isLoading) return <Spinner label="Loading validation…" />;
  if (run.error || !run.data) return <ErrorState error={run.error ?? new Error('Validation not found')} />;
  const v = run.data;
  const s = v.summary;

  return (
    <>
      <WizardSteps
        current={done ? 9 : 8}
        links={v.migrationRunId ? { 7: `/runs/${v.migrationRunId}` } : {}}
      />
      <PageHeader
        title="Validation report"
        description={
          <>
            <span className="text-[var(--color-source)]">{v.sourceEnvironment.displayName}</span>{' '}
            <ArrowRight className="inline h-3.5 w-3.5" />{' '}
            <span className="text-[var(--color-target)]">{v.targetEnvironment.displayName}</span> ·{' '}
            {fmtDate(v.createdAt)}
            {v.createdBy && ` · by ${v.createdBy}`}
            {v.migrationRunId && (
              <>
                {' '}
                ·{' '}
                <Link to={`/runs/${v.migrationRunId}`} className="font-medium text-brand-700 hover:underline">
                  migration run
                </Link>
              </>
            )}
          </>
        }
        actions={
          <>
            <StatusBadge status={v.status} />
            {v.outcome && <StatusBadge status={v.outcome} className="text-sm" />}
          </>
        }
      />
      {['QUEUED', 'RUNNING'].includes(v.status) && (
        <Card>
          <div className="flex items-center gap-3 text-sm text-slate-600">
            <StatusBadge status={v.status} /> {v.progressMessage}
          </div>
        </Card>
      )}
      {v.status === 'FAILED' && <ErrorState error={new Error(`Validation failed: ${v.errorMessage}`)} />}

      {done && s && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat
              label="Tables"
              value={s.tablesValidated}
              hint={`${s.pass} pass · ${s.warning} warn · ${s.fail} fail`}
            />
            <Stat label="Source rows" value={fmtNumber(s.sourceRows)} />
            <Stat label="Target rows" value={fmtNumber(s.targetRows)} />
            <Stat label="Migrated" value={fmtNumber(s.migratedRows)} />
            <Stat label="Matched" tone="green" value={fmtNumber(s.matchedRecords)} />
            <Stat
              label="Missing"
              tone={s.missingRecords ? 'red' : 'default'}
              value={fmtNumber(s.missingRecords)}
              onClick={() => {
                setType('MISSING_IN_TARGET');
                setPage(0);
              }}
            />
            <Stat
              label="Different"
              tone={s.differentRecords ? 'amber' : 'default'}
              value={fmtNumber(s.differentRecords)}
              onClick={() => {
                setType('VALUE_MISMATCH');
                setPage(0);
              }}
            />
            <Stat
              label="Broken refs"
              tone={s.brokenReferences ? 'red' : 'default'}
              value={fmtNumber(s.brokenReferences)}
              onClick={() => {
                setType('BROKEN_REFERENCE');
                setPage(0);
              }}
            />
          </div>

          <Card
            title="Results by table"
            actions={<ExportButton href={`/api/validations/${v.id}/summary.csv`} label="Export summary" />}
            bodyClassName="p-0"
          >
            <Table>
              <thead className="bg-slate-50">
                <tr>
                  <Th className="w-8" />
                  <Th>Table</Th>
                  <Th>Outcome</Th>
                  <Th className="text-right">Source</Th>
                  <Th className="text-right">Target</Th>
                  <Th className="text-right">Checked</Th>
                  <Th className="text-right">Matched</Th>
                  <Th className="text-right">Missing</Th>
                  <Th className="text-right">Different</Th>
                  <Th className="text-right">Broken refs</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {v.entities.map((e) => {
                  const open = expanded === e.logicalName;
                  return (
                    <Fragment key={e.logicalName}>
                      <tr
                        className="cursor-pointer hover:bg-slate-50"
                        onClick={() => setExpanded(open ? null : e.logicalName)}
                        data-testid={`validation-entity-${e.logicalName}`}
                      >
                        <Td>
                          {open ? (
                            <ChevronDown className="h-4 w-4 text-slate-400" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-slate-400" />
                          )}
                        </Td>
                        <Td>
                          <div className="font-medium text-slate-900">{e.displayName}</div>
                          <Mono>{e.logicalName}</Mono>
                        </Td>
                        <Td>
                          <StatusBadge status={e.outcome} />
                        </Td>
                        <Td className="text-right tabular-nums">{fmtNumber(e.sourceCount)}</Td>
                        <Td className="text-right tabular-nums">{fmtNumber(e.targetCount)}</Td>
                        <Td className="text-right tabular-nums">{fmtNumber(e.checkedRecords)}</Td>
                        <Td className="text-right tabular-nums">{fmtNumber(e.matched)}</Td>
                        <Td className={`text-right tabular-nums ${e.missing ? 'text-red-700' : ''}`}>
                          {fmtNumber(e.missing)}
                        </Td>
                        <Td className={`text-right tabular-nums ${e.different ? 'text-amber-700' : ''}`}>
                          {fmtNumber(e.different)}
                        </Td>
                        <Td className={`text-right tabular-nums ${e.brokenReferences ? 'text-red-700' : ''}`}>
                          {fmtNumber(e.brokenReferences)}
                        </Td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={10} className="bg-slate-50/70 px-6 py-3">
                            <ul className="space-y-1.5">
                              {e.checks.map((c) => (
                                <li key={c.check} className="flex items-start gap-3 text-sm">
                                  <StatusBadge status={c.outcome} className="w-20 justify-center" />
                                  <span className="w-40 flex-none text-xs font-semibold uppercase tracking-wide text-slate-500">
                                    {humanize(c.check)}
                                  </span>
                                  <span className="text-slate-700">{c.message}</span>
                                </li>
                              ))}
                            </ul>
                            <button
                              type="button"
                              className="mt-2 text-xs font-medium text-brand-700 underline"
                              onClick={() => {
                                setEntity(e.logicalName);
                                setType('');
                                setPage(0);
                                document
                                  .getElementById('differences')
                                  ?.scrollIntoView({ behavior: 'smooth' });
                              }}
                            >
                              Inspect differences for {e.displayName}
                            </button>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </Card>

          <div id="differences">
            <Card
              title="Differences"
              subtitle="Values are normalized before comparison; secured columns are masked and long values truncated."
              actions={
                <>
                  <Select
                    label="Table"
                    value={entity}
                    onChange={(x) => {
                      setEntity(x);
                      setPage(0);
                    }}
                    options={[
                      { value: '', label: 'All tables' },
                      ...v.entities.map((e) => ({ value: e.logicalName, label: e.displayName })),
                    ]}
                  />
                  <Select
                    label="Difference type"
                    value={type}
                    onChange={(x) => {
                      setType(x);
                      setPage(0);
                    }}
                    options={[
                      { value: '', label: 'All types' },
                      ...(
                        [
                          'MISSING_IN_TARGET',
                          'VALUE_MISMATCH',
                          'LOOKUP_MISMATCH',
                          'BROKEN_REFERENCE',
                          'PRE_EXISTING_DIFFERENCE',
                        ] as DifferenceType[]
                      ).map((t) => ({ value: t, label: humanize(t) })),
                    ]}
                  />
                  <Select
                    label="Outcome"
                    value={outcome}
                    onChange={(x) => {
                      setOutcome(x);
                      setPage(0);
                    }}
                    options={[
                      { value: '', label: 'Fail & warning' },
                      { value: 'FAIL', label: 'Fail' },
                      { value: 'WARNING', label: 'Warning' },
                    ]}
                  />
                  <ExportButton
                    href={`/api/validations/${v.id}/differences.csv${qs({
                      entity: entity || undefined,
                      type: type || undefined,
                      outcome: outcome || undefined,
                    })}`}
                    label="Export differences"
                  />
                </>
              }
              bodyClassName="p-0"
            >
              {diffs.isLoading && <Spinner />}
              {diffs.error && (
                <div className="p-4">
                  <ErrorState error={diffs.error} />
                </div>
              )}
              {diffs.data?.total === 0 && (
                <EmptyState title="No differences" description="Nothing matches these filters." />
              )}
              {diffs.data && diffs.data.total > 0 && (
                <>
                  <Table>
                    <thead className="bg-slate-50">
                      <tr>
                        <Th>Table</Th>
                        <Th>Record</Th>
                        <Th>Field</Th>
                        <Th>Source value</Th>
                        <Th>Target value</Th>
                        <Th>Type</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {diffs.data.items.map((d) => (
                        <tr key={d.id} data-testid="difference-row">
                          <Td>{d.entity}</Td>
                          <Td>
                            <Mono>{d.sourceRecordId ?? '—'}</Mono>
                            {d.targetRecordId && d.targetRecordId !== d.sourceRecordId && (
                              <div className="text-[11px] text-slate-500">
                                target <Mono>{d.targetRecordId}</Mono>
                              </div>
                            )}
                          </Td>
                          <Td>
                            <Mono>{d.field ?? '—'}</Mono>
                          </Td>
                          <Td className="max-w-xs break-words text-xs">
                            {d.sourceValue ?? <span className="text-slate-400">empty</span>}
                          </Td>
                          <Td className="max-w-xs break-words text-xs">
                            {d.targetValue ?? <span className="text-slate-400">empty</span>}
                          </Td>
                          <Td className="space-y-1">
                            <StatusBadge status={d.outcome} />
                            <div className="text-[11px] text-slate-500">{humanize(d.differenceType)}</div>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <Pager page={page} total={diffs.data.total} onPage={setPage} />
                </>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
