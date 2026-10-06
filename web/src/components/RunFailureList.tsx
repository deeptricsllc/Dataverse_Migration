import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { MigrationErrorDto, MigrationRunDto, RunRecordDetailDto } from '@shared/domain';
import { correctionFor, type CorrectionTarget } from '@shared/failure-categories';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  Mono,
  Pager,
  Pill,
  Select,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from './ui';
import { get, qs } from '../lib/api';
import { fmtDate } from '../lib/format';

const PAGE = 50;

/**
 * Every failure in a run, as a list somebody works through.
 *
 * What this replaces was a table of error codes and raw messages: correct, complete, and unusable, because
 * reading it required knowing what `AMBIGUOUS_TARGET_MATCH` means and what to do about it. The codes are
 * still here — a connector's own code is what a person searches the target's documentation for — but each
 * row now says what it means for the records in it, and each one opens onto the record itself.
 *
 * Filtered and paged on the server. A run can hold millions of error rows, and a filter that works by
 * fetching them all and narrowing in the browser stops working at exactly the size where somebody needs it.
 */
export function RunFailureList({ run, codes }: { run: MigrationRunDto; codes: string[] }) {
  const [kind, setKind] = useState<'all' | 'retryable' | 'permanent'>('all');
  const [entity, setEntity] = useState('');
  const [severity, setSeverity] = useState<'' | 'ERROR' | 'WARNING'>('');
  const [code, setCode] = useState('');
  const [attempt, setAttempt] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  const query = {
    kind,
    entity: entity || undefined,
    severity: severity || undefined,
    code: code || undefined,
    attempt: attempt || undefined,
    sourceRecordId: applied || undefined,
  };
  const q = useQuery({
    queryKey: ['run-errors', run.id, query, page, run.processed, run.status],
    queryFn: () =>
      get<{ items: MigrationErrorDto[]; total: number }>(
        `/api/runs/${run.id}/errors${qs({ ...query, limit: PAGE, offset: page * PAGE })}`,
      ),
  });

  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(0);
      setOpen(null);
    };

  return (
    <Card
      title="Failures and warnings"
      subtitle="Each row is one record and one cause. A failure is isolated to its record; the run continues."
      actions={
        <>
          <Select
            label="Dataset"
            value={entity}
            onChange={reset(setEntity)}
            options={[
              { value: '', label: 'All datasets' },
              ...run.entities.map((e) => ({ value: e.logicalName, label: e.displayName })),
            ]}
          />
          {/* The causes this run actually recorded, not every code the product knows. */}
          <Select
            label="Cause"
            value={code}
            onChange={reset(setCode)}
            options={[{ value: '', label: 'All causes' }, ...codes.map((c) => ({ value: c, label: c }))]}
          />
          <Select
            label="Can another attempt succeed"
            value={kind}
            onChange={reset(setKind as (v: string) => void)}
            options={[
              { value: 'all', label: 'Either' },
              { value: 'retryable', label: 'Yes' },
              { value: 'permanent', label: 'No' },
            ]}
          />
          <Select
            label="Severity"
            value={severity}
            onChange={reset(setSeverity as (v: string) => void)}
            options={[
              { value: '', label: 'Failures and warnings' },
              { value: 'ERROR', label: 'Failures' },
              { value: 'WARNING', label: 'Warnings' },
            ]}
          />
          {/*
            Attempt is offered only once there is more than one, and it excludes rows with no recorded
            attempt rather than attributing them to the first one.
          */}
          {run.attempt > 1 && (
            <Select
              label="Attempt"
              value={attempt}
              onChange={reset(setAttempt)}
              options={[
                { value: '', label: 'Every attempt' },
                ...Array.from({ length: run.attempt }, (_, i) => ({
                  value: String(i + 1),
                  label: `Attempt ${i + 1}`,
                })),
              ]}
            />
          )}
          <form
            className="flex items-end gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied(search.trim());
              setPage(0);
              setOpen(null);
            }}
          >
            <label className="text-xs text-slate-500">
              <span className="block">Source record</span>
              <input
                className="mt-0.5 w-56 rounded-md border border-slate-300 px-2 py-1 text-sm"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Identifier"
                data-testid="failure-search"
              />
            </label>
            <Button variant="secondary" type="submit">
              Find
            </Button>
          </form>
          {/*
            The same filters the list is showing, which is the property that makes the file usable: an export
            taken while looking at one record used to come back with every row in the run.
          */}
          <ExportButton
            href={`/api/runs/${run.id}/errors.csv${qs(query)}`}
            title="Every failure matching the filters above, not only the page on screen."
          />
        </>
      }
      bodyClassName="p-0"
    >
      {q.isLoading && <Spinner />}
      {q.error && (
        <div className="p-4">
          <ErrorState error={q.error} />
        </div>
      )}
      {q.data?.total === 0 && (
        <EmptyState
          title={applied ? 'No failures for that record' : 'No failures'}
          description="Nothing in this run matches these filters."
        />
      )}
      {q.data && q.data.total > 0 && (
        <>
          <Table>
            <thead className="bg-slate-50">
              <tr>
                <Th>Record</Th>
                <Th>Dataset</Th>
                <Th>Cause</Th>
                <Th>What it means</Th>
                <Th>Another attempt</Th>
                <Th>Recorded</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {q.data.items.map((e) => {
                const expanded = open === e.id;
                return (
                  <>
                    <tr
                      key={e.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => setOpen(expanded ? null : e.id)}
                      data-testid="run-error-row"
                    >
                      <Td>
                        <span className="flex items-center gap-1">
                          {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                          )}
                          <Mono>{e.sourceRecordId ?? 'Whole dataset'}</Mono>
                        </span>
                      </Td>
                      <Td className="text-xs">{e.entity}</Td>
                      <Td>
                        <div className="text-sm text-slate-900">{e.category.label}</div>
                        {e.category.known && <Mono className="text-[11px]">{e.errorCode}</Mono>}
                      </Td>
                      <Td className="max-w-md text-xs text-slate-600">{e.category.meaning ?? e.message}</Td>
                      <Td className="space-y-1">
                        <StatusBadge status={e.severity} />
                        <div>
                          {e.retryable ? (
                            <Pill tone="blue">Could succeed</Pill>
                          ) : (
                            <Pill>Will not succeed</Pill>
                          )}
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-slate-500">
                        {fmtDate(e.createdAt)}
                        {e.runAttempt !== null && <div>Attempt {e.runAttempt}</div>}
                      </Td>
                    </tr>
                    {expanded && (
                      <tr key={`${e.id}-detail`} className="bg-slate-50/60">
                        <td colSpan={6} className="px-4 py-4">
                          <FailureDetail run={run} error={e} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </Table>
          <Pager page={page} total={q.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

/**
 * One failure, opened.
 *
 * Three things, in the order a person needs them: what this record is, what to do about it, and — behind a
 * disclosure — the technical detail that goes in a ticket. The last of those is last because it answers a
 * different question from the first two, and putting it first is what made the old table unreadable.
 */
function FailureDetail({ run, error }: { run: MigrationRunDto; error: MigrationErrorDto }) {
  const [technical, setTechnical] = useState(false);
  const detail = useQuery({
    queryKey: ['run-record', run.id, error.entity, error.sourceRecordId],
    queryFn: () =>
      get<RunRecordDetailDto>(
        `/api/runs/${run.id}/records/${error.entity}/${encodeURIComponent(error.sourceRecordId!)}`,
      ),
    enabled: !!error.sourceRecordId,
  });
  const correction = correctionFor(error.errorCode);

  return (
    <div className="space-y-4" data-testid="failure-detail">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">This record</p>
          {detail.isLoading && <Spinner />}
          {!error.sourceRecordId && (
            <p className="mt-1 text-sm text-slate-600">
              This failure is about the dataset, not one record. No record was attempted.
            </p>
          )}
          {detail.data && (
            <dl className="mt-1 space-y-1 text-sm">
              {detail.data.evidence.map((ev) => (
                <div key={ev.label} className="flex gap-2">
                  <dt className="w-40 shrink-0 text-slate-500">{ev.label}</dt>
                  <dd className="min-w-0 break-all text-slate-900">
                    {ev.value ?? <span className="text-slate-400">Not recorded</span>}
                  </dd>
                </div>
              ))}
              <div className="flex gap-2">
                <dt className="w-40 shrink-0 text-slate-500">Outcome</dt>
                <dd>
                  <StatusBadge status={detail.data.outcome} />
                </dd>
              </div>
            </dl>
          )}
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">What to do</p>
          <p className="mt-1 text-sm text-slate-900">
            {error.category.action ?? 'Read the message from the target below.'}
          </p>
          {/*
            The message the target gave, kept verbatim. The product's own wording explains the category;
            this is the only text that can say what went wrong with this particular record, and
            paraphrasing it would lose the part somebody searches for.
          */}
          <p className="mt-2 rounded-md bg-white p-2 text-xs text-slate-700 ring-1 ring-slate-200">
            {error.message}
          </p>
          {correction && run.projectId ? (
            <CorrectionLink
              target={correction.target}
              label={correction.label}
              projectId={run.projectId}
              planId={run.planId}
            />
          ) : (
            /*
             * No button, on purpose. Either nothing in the configuration is wrong — a throttled request, a
             * timeout — or this run predates projects owning migrations and there is nowhere to send
             * somebody. An action that leads to an unrelated screen costs the trip and the trust.
             */
            <p className="mt-3 text-xs text-slate-500">
              {correction
                ? 'This run is not part of a migration project, so there is nowhere to open.'
                : 'There is nothing to correct in the configuration. Retry these records.'}
            </p>
          )}
        </div>
      </div>

      <div>
        <button
          type="button"
          className="text-xs font-medium text-brand-700 hover:underline"
          onClick={() => setTechnical(!technical)}
          data-testid="toggle-technical"
        >
          {technical ? 'Hide technical details' : 'Technical details'}
        </button>
        {technical && (
          <dl
            className="mt-2 grid gap-x-6 gap-y-1 rounded-md bg-white p-3 text-xs ring-1 ring-slate-200 sm:grid-cols-2"
            data-testid="technical-details"
          >
            <Fact label="Error code" value={error.errorCode} mono />
            <Fact label="Operation" value={error.operation} />
            <Fact label="Run" value={run.id} mono />
            <Fact label="Attempt" value={error.runAttempt === null ? null : String(error.runAttempt)} />
            <Fact label="Dataset" value={error.entity} mono />
            <Fact label="Target table" value={error.targetTable ?? error.entity} mono />
            <Fact label="Source record" value={error.sourceRecordId} mono />
            <Fact label="Field" value={error.field} mono />
            <Fact
              label="Target response"
              value={error.httpStatus === null ? null : String(error.httpStatus)}
            />
            <Fact label="Attempts on this record" value={String(error.attempts)} />
            <Fact label="Recorded at" value={fmtDate(error.createdAt)} />
            {/*
              There is no correlation identifier on a record failure. The engine does not record one, and
              inventing a value for a field a ticket would be raised against is the worst place to guess.
            */}
            <Fact label="Correlation id" value={null} />
            <Fact label="Write state" value={detail.data?.writeState ?? null} />
            <Fact label="Deferred references" value={detail.data?.deferredStatus ?? null} />
          </dl>
        )}
      </div>
    </div>
  );
}

/** One recorded fact, or an explicit statement that it was not recorded. Never a blank and never a zero. */
function Fact({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-44 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 break-all text-slate-900">
        {value === null || value === '' ? (
          <span className="text-slate-400">Not recorded</span>
        ) : mono ? (
          <Mono>{value}</Mono>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/**
 * The place this failure is fixed.
 *
 * One destination per correction target, and each one is a screen that exists and changes the outcome.
 * Nothing here links to a place that merely mentions the problem.
 */
function CorrectionLink({
  target,
  label,
  projectId,
  planId,
}: {
  target: CorrectionTarget;
  label: string;
  projectId: string;
  planId: string;
}) {
  const to =
    target === 'SOURCE_DATA'
      ? `/migration/${projectId}?section=data`
      : target === 'MAPPING'
        ? `/migration/${projectId}?section=mapping`
        : target === 'DEPENDENCIES'
          ? `/migration/${projectId}?section=dependencies`
          : target === 'MATCHING'
            ? `/migration/plans/${planId}`
            : target === 'OWNERS'
              ? '/users'
              : '/environments';
  return (
    <Link
      to={to}
      className="mt-3 inline-block rounded-md bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800"
      data-testid="corrective-action"
    >
      {label}
    </Link>
  );
}
