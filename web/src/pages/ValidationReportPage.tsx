import { AGGREGATE_CAVEAT, type AggregateCheck } from '@shared/aggregates';
import type {
  ComparisonRulesDto,
  ValidationEntityResultDto,
  DifferenceType,
  IdentityBasis,
  ValidationDifferenceDto,
  ValidationRunDto,
  ValidationSummary,
} from '@shared/domain';
import { explainFinding, findingLabel } from '@shared/validation-findings';
import { accountedFor, METRIC_DEFINITIONS, writtenByRun, type RecordAccounting } from '@shared/run-metrics';
import {
  coveragePercent,
  describeClean,
  VALIDATION_DEPTHS,
  type ValidationCoverage,
} from '@shared/validation-coverage';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Callout,
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  Mono,
  PageHeader,
  Pager,
  Pill,
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

const PAGE = 50;

const OUTCOME_LABELS: Record<string, string> = {
  PASS: 'All checks passed',
  WARNING: 'Passed with warnings',
  /* Not a kind of pass: a required comparison could not run, so the headline must not say passed. */
  INCOMPLETE: 'Incomplete',
  FAIL: 'Checks failed',
};

/**
 * What the report means, in words, before any table of numbers.
 *
 * The tiles are accurate and were being misread: "source rows 30, target rows 144" invites the
 * conclusion that something went badly wrong, when it only means the target already held data. A
 * report that has to be interpreted correctly to be useful is a report that will be interpreted
 * incorrectly, so the plain reading goes first and the numbers back it up.
 */
function Verdict({
  summary,
  outcome,
  migrationRunId,
  entities,
}: {
  summary: ValidationSummary;
  outcome: string | null;
  migrationRunId: string | null;
  /** The datasets, so the headline can name the checks that could not be completed. */
  entities: ValidationEntityResultDto[];
}) {
  const s = summary;
  const checked = s.matchedRecords + s.missingRecords + s.differentRecords;
  // A run that did not deliver records is not a clean result, whatever the reason it gives.
  const clean =
    s.missingRecords === 0 &&
    s.failedInRunRecords === 0 &&
    s.differentRecords === 0 &&
    s.brokenReferences === 0;
  /*
   * INCOMPLETE is not a success tone. Without it the whole headline of a validation that could not
   * run went out green, which is the same defect as the word "passed" one level up: a reader takes
   * the colour before the words.
   */
  const tone =
    outcome === 'FAIL' ? 'danger' : outcome === 'WARNING' || outcome === 'INCOMPLETE' ? 'warning' : 'success';
  /** Checks that could not be completed, by name. The fourth question the first viewport must answer. */
  const unverified = entities.flatMap((e) =>
    e.checks.filter((c) => c.outcome === 'INCOMPLETE').map((c) => ({ entity: e.displayName, check: c })),
  );

  const lines: ReactNode[] = [];
  lines.push(
    <>
      <strong>{fmtNumber(checked)}</strong> record(s) were checked across{' '}
      <strong>{fmtNumber(s.tablesValidated)}</strong> table(s), comparing the target against the source rather
      than re-reading the migration&apos;s own work.
    </>,
  );
  // What a clean result is allowed to say, derived from how much was examined. "All checks passed"
  // over a sample is the sentence this exists to prevent.
  if (clean && s.coverage) {
    lines.push(<>{describeClean(s.coverage)}</>);
  }
  if (s.matchedRecords > 0) {
    lines.push(
      <>
        <strong className="text-emerald-700">{fmtNumber(s.matchedRecords)}</strong> match the source on every
        field that was compared.
      </>,
    );
  }
  if (s.missingRecords > 0) {
    lines.push(
      <>
        <strong className="text-red-700">{fmtNumber(s.missingRecords)}</strong> were expected in the target
        and are not there, although the run did not report a failure for them. That is this report&apos;s own
        finding
        {migrationRunId ? (
          <>
            {' '}
            (
            <Link to={`/runs/${migrationRunId}`} className="font-medium text-brand-700 hover:underline">
              see the run
            </Link>
            )
          </>
        ) : null}
        .
      </>,
    );
  }
  if (s.failedInRunRecords > 0) {
    // The run already said these failed. Confirming it is useful; counting it as a validation
    // miss is not, and adding the two made matched + missing + differing exceed the number of
    // records examined.
    lines.push(
      <>
        <strong className="text-red-700">{fmtNumber(s.failedInRunRecords)}</strong> were reported as failed by
        the run itself and are confirmed absent. They were never compared, because there is nothing in the
        target to compare them against
        {migrationRunId ? (
          <>
            {' '}
            (
            <Link to={`/runs/${migrationRunId}`} className="font-medium text-brand-700 hover:underline">
              see the run for why
            </Link>
            )
          </>
        ) : null}
        .
      </>,
    );
  }
  if (s.differentRecords > 0) {
    lines.push(
      <>
        <strong className="text-amber-700">{fmtNumber(s.differentRecords)}</strong> exist on both sides but
        hold a different value in at least one field. Each one is listed below.
      </>,
    );
  }
  /*
   * Why a difference can be a warning rather than a failure.
   *
   * Without this the headline read "Passed with warnings" over "2 hold a different value", and left
   * the reader to work out which two and whose fault they were. A record the run found already in
   * the target and left alone is not a record the run got wrong, and that is the whole reason the
   * outcome is not a failure — so it belongs in the headline, not in a panel further down.
   */
  const preExisting = entities.reduce((n, e) => n + (e.findings?.PRE_EXISTING_DIFFERENCE ?? 0), 0);
  if (preExisting > 0) {
    lines.push(
      <>
        <strong>{fmtNumber(preExisting)}</strong> of the differences below are in records this run did not
        write. The target already held them and the run left them as they were, so this migration did not
        cause them.
      </>,
    );
  }
  if (s.brokenReferences > 0) {
    lines.push(
      <>
        <strong className="text-red-700">{fmtNumber(s.brokenReferences)}</strong> lookup value(s) point at a
        record that does not exist in the target.
      </>,
    );
  }
  /*
   * The strongest sentence on the page, and it may only be said when nothing limits it.
   *
   * It appeared directly above "1 check could not be completed", so a reader scanning the list met
   * "Nothing is missing" first and the limit second. Nothing is missing *among the records that were
   * checked* — and on this report one record had been left out because nobody could account for it,
   * which is the one fact the sentence was covering up.
   */
  if (clean && checked > 0 && s.coverage?.mode === 'FULL' && unverified.length === 0) {
    lines.push(<>Nothing is missing, nothing differs, and every reference resolves.</>);
  }
  if (s.duplicateRecords > 0) {
    lines.push(
      <>
        <strong className="text-amber-700">{fmtNumber(s.duplicateRecords)}</strong> record(s) share a key
        value that should identify one record. They are listed by table below.
      </>,
    );
  }
  /*
    Saying nothing here would let a clean report be read as "no duplicates". If every table was
    counted over its own primary key, nothing repeated because nothing could — the target refuses a
    repeated primary key by itself — so the report has to say which claim it is actually making.
  */
  if (s.duplicateRecords === 0 && s.businessUniquenessVerifiedTables === 0 && s.tablesValidated > 0) {
    lines.push(
      <>
        No <strong>duplicate primary keys</strong> were found, which the target guarantees in any case.
        Business-level uniqueness was <strong>not verified</strong>: no table in this run has an alternate or
        business key configured, so nothing here shows whether the same real-world record arrived twice. Set a
        match key on the plan to have that checked.
      </>,
    );
  } else if (s.duplicateRecords === 0 && s.businessUniquenessVerifiedTables === null) {
    lines.push(
      <>
        This report predates recording which key the duplicate check grouped on, so what the zero above proves
        is not known.
      </>,
    );
  }
  if (s.targetRows > s.sourceRows) {
    lines.push(
      <>
        The target holds <strong>{fmtNumber(s.targetRows)}</strong> row(s) against the source&apos;s{' '}
        <strong>{fmtNumber(s.sourceRows)}</strong>. That is expected: it already contained data before this
        migration, and validation only checks the records this run was responsible for.
      </>,
    );
  }
  // Checking a record and writing it are different things, and a report that only gives the first
  // number invites the reader to assume the run wrote everything it verified.
  if (s.accounting) {
    const written = writtenByRun(s.accounting);
    const alreadyThere = s.accounting.unchanged + s.accounting.skipped;
    lines.push(
      written === 0 && alreadyThere > 0 ? (
        <>
          This run wrote <strong>nothing</strong>: all <strong>{fmtNumber(alreadyThere)}</strong> record(s) it
          accounted for were already in the target and were left as they were. What is verified below is the
          state of that existing data, not work this run did.
        </>
      ) : (
        <>
          <strong>{fmtNumber(written)}</strong> record(s) were written by this run (
          {fmtNumber(s.accounting.created)} created, {fmtNumber(s.accounting.updated)} updated)
          {alreadyThere > 0 ? (
            <>
              ; <strong>{fmtNumber(alreadyThere)}</strong> were already in the target and left alone
            </>
          ) : null}
          .
        </>
      ),
    );
  }

  /*
   * What could not be checked, said in the headline rather than left to the panels below.
   *
   * A reader who sees no failures and scrolls no further has read a report that checked nothing, and
   * every number above this line is silent about that.
   */
  if (unverified.length > 0) {
    lines.push(
      <>
        <strong className="text-amber-700">{fmtNumber(unverified.length)}</strong> check(s) could not be
        completed:{' '}
        {unverified
          .slice(0, 4)
          .map((u) => `${u.entity} · ${humanize(u.check.check)}`)
          .join('; ')}
        {unverified.length > 4 ? ` and ${unverified.length - 4} more` : ''}. Nothing there is known to be
        wrong. It was not checked.
      </>,
    );
  }

  /*
   * What to do, last and plainly. State, evidence, consequence, action — the action was the one the
   * report left to the reader to work out.
   */
  lines.push(
    outcome === 'FAIL' ? (
      <strong>Next action: review the findings below, then correct the mapping or the data.</strong>
    ) : outcome === 'INCOMPLETE' ? (
      <strong>Next action: resolve what could not be checked, then validate again.</strong>
    ) : outcome === 'WARNING' ? (
      <strong>Next action: read the warnings below before you accept this result.</strong>
    ) : (
      <strong>Next action: none. Export this report as evidence of the comparison.</strong>
    ),
  );

  // Callout takes no test id of its own, and a wrapper is cheaper than widening its props.
  return (
    <div data-testid="validation-verdict">
      <Callout tone={tone} title={outcome ? (OUTCOME_LABELS[outcome] ?? outcome) : 'Validation complete'}>
        <ul className="space-y-1.5">
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}

/**
 * How much of the data this report is actually about.
 *
 * Given its own panel rather than a footnote, because it qualifies every other number on the page.
 * The three states are never styled alike: a sample that found nothing and a check that could not
 * run are both "no failures found" and neither is "it is correct".
 */
function CoveragePanel({ coverage, depth }: { coverage: ValidationCoverage | null; depth: string | null }) {
  if (!coverage) {
    return (
      <Callout tone="info" title="Coverage was not recorded for this report">
        This report predates coverage being recorded, so how much of the data it examined is not known. Re-run
        the validation to find out.
      </Callout>
    );
  }
  const tone = coverage.mode === 'FULL' ? 'success' : coverage.mode === 'SAMPLED' ? 'warning' : 'info';
  const title =
    coverage.mode === 'FULL'
      ? 'Full validation'
      : coverage.mode === 'SAMPLED'
        ? `Sampled validation: ${coveragePercent(coverage)}% of eligible records`
        : 'Not fully verified';
  const depthMeta = depth ? VALIDATION_DEPTHS[depth as keyof typeof VALIDATION_DEPTHS] : null;
  return (
    <div data-testid="validation-coverage">
      <Callout tone={tone} title={title}>
        <dl className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-500">Eligible records</dt>
            <dd className="font-medium tabular-nums">{fmtNumber(coverage.eligible)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Examined</dt>
            <dd className="font-medium tabular-nums">{fmtNumber(coverage.examined)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Coverage</dt>
            <dd className="font-medium tabular-nums">{coveragePercent(coverage)}%</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Depth</dt>
            <dd className="font-medium">{depthMeta?.label ?? '—'}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs">
          {coverage.strategy}
          {coverage.cap !== null && ` Capped at ${fmtNumber(coverage.cap)} records per table.`}
        </p>
        {coverage.mode === 'SAMPLED' && (
          <p className="mt-1 text-xs">
            Nothing is claimed about the {fmtNumber(coverage.eligible - coverage.examined)} record(s) that
            were not examined. Run a full validation to cover them.
          </p>
        )}
        {coverage.reason && <p className="mt-1 text-xs">{coverage.reason}</p>}
      </Callout>
    </div>
  );
}

/**
 * What the run did with every record it touched, in the five buckets that do not overlap.
 *
 * On the report rather than only on the run page, because this is the screen somebody reads to
 * decide whether the migration worked, and "28 records verified" means something very different
 * depending on whether this run put them there.
 */
/**
 * Totals compared across the two sides.
 *
 * Shown with its scope attached to every row, because this is the one panel in the report somebody
 * will quote out of context. A SUM that agrees is worth reading; a SUM that agrees over a target
 * holding records this run never wrote is worth nothing, and the only thing separating the two is
 * the sentence next to the number. The caveat sits under the table in the same type as the numbers,
 * not in a tooltip.
 */
function AggregatePanel({ aggregates, entity }: { aggregates: AggregateCheck[]; entity: string }) {
  if (aggregates.length === 0) return null;
  const unverified = aggregates.filter((a) => a.outcome === 'NOT_VERIFIED');
  return (
    <div className="mt-3" data-testid={`aggregates-${entity}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Totals compared</p>
      {aggregates.length === unverified.length ? (
        // Nothing was compared. Saying which figure was unavailable and why beats an empty table
        // that reads as "no problems found".
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          No totals could be compared. {unverified[0]!.reason} {unverified[0]!.scope}
        </p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {aggregates.map((a) => (
            <li key={`${a.kind}-${a.column ?? 'rows'}`} className="flex flex-wrap items-baseline gap-2">
              <span className="w-28 flex-none text-xs font-semibold uppercase tracking-wide text-slate-500">
                {a.kind}
                {a.column ? ` · ${a.column}` : ''}
              </span>
              {a.outcome === 'NOT_VERIFIED' ? (
                <Pill tone="slate" title={a.reason}>
                  not verified
                </Pill>
              ) : (
                <>
                  <Mono className="text-xs">{a.sourceValue ?? '—'}</Mono>
                  <ArrowRight className="h-3 w-3 text-slate-400" aria-hidden />
                  <Mono className={`text-xs ${a.outcome === 'FAIL' ? 'text-red-700' : ''}`}>
                    {a.targetValue ?? '—'}
                  </Mono>
                  {a.outcome === 'FAIL' && <Pill tone="red">differs</Pill>}
                </>
              )}
              <span className="text-xs text-slate-400">{a.scope}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 max-w-3xl text-xs text-slate-500">{AGGREGATE_CAVEAT}</p>
    </div>
  );
}

/** What each identity basis proves, in the one sentence a reader needs beside the finding. */
const IDENTITY_BASIS: Record<IdentityBasis, string> = {
  MIGRATION_IDENTITY_MAP:
    'The identity map this run wrote. Each source record is paired with the target record the run created for it.',
  PRIMARY_KEY:
    'The same primary identifier on both sides. This proves the record with that identifier agrees. It does not prove this run wrote it.',
  BUSINESS_KEY: 'A configured business key.',
  ALTERNATE_KEY: 'A target alternate key.',
};

/**
 * The rules the comparison ran under.
 *
 * Shown with the result, not with the plan. A reader who cannot see which columns were compared, and
 * which were left out, cannot tell a report that checked everything from one that checked the
 * forty-seven columns nobody asked about. The excluded columns are listed by name for the same
 * reason: a count invites the reader to assume the rest did not matter.
 */
/**
 * What was found in this dataset, by kind, and what could not be checked.
 *
 * Findings, not records, and labelled as findings: one record with four wrong columns is one
 * different record and four findings, and a reader who takes either number for the other draws the
 * wrong conclusion in both directions. The dataset row above counts records; this counts findings.
 *
 * The checks that could not be completed are here too, because a dataset with no findings and one
 * unverified check is not a dataset with nothing wrong — it is a dataset nobody finished looking at.
 */
function FindingBreakdown({
  findings,
  checks,
  entity,
}: {
  findings: Partial<Record<DifferenceType, number>> | null;
  checks: { check: string; outcome: string; message: string }[];
  entity: string;
}) {
  const unverified = checks.filter((c) => c.outcome === 'INCOMPLETE');
  const kinds = Object.entries(findings ?? {}).filter(([, n]) => (n ?? 0) > 0) as [DifferenceType, number][];
  if (kinds.length === 0 && unverified.length === 0) return null;
  return (
    <div className="mt-3" data-testid={`findings-${entity}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Findings</p>
      {kinds.length === 0 ? (
        <p className="mt-1 text-sm text-slate-600">No findings.</p>
      ) : (
        <ul className="mt-1 space-y-0.5 text-sm">
          {kinds.map(([type, n]) => (
            <li key={type} className="flex flex-wrap items-baseline gap-2">
              <span className="w-48 flex-none text-slate-700">{findingLabel(type)}</span>
              <span className="tabular-nums text-slate-900">{fmtNumber(n)}</span>
              <span className="text-xs text-slate-500">finding(s)</span>
            </li>
          ))}
        </ul>
      )}
      {unverified.length > 0 && (
        <>
          <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Checks not completed
          </p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {unverified.map((c) => (
              <li key={c.check} className="flex flex-wrap items-baseline gap-2">
                <span className="w-48 flex-none text-slate-700">{humanize(c.check)}</span>
                <span className="text-slate-600">{c.message}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function RulesPanel({ rules, entity }: { rules: ComparisonRulesDto | null; entity: string }) {
  const [open, setOpen] = useState(false);
  if (!rules) {
    return (
      <p className="mt-3 text-xs text-slate-500" data-testid={`rules-${entity}`}>
        Comparison rules not recorded. This report was produced before the platform recorded them.
      </p>
    );
  }
  const transformed = rules.comparedFields.filter((f) => f.transformations.length > 0);
  return (
    <div className="mt-3" data-testid={`rules-${entity}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Comparison rules</p>
      <dl className="mt-1 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-slate-500">Identity</dt>
        <dd className="text-slate-700">
          {humanize(rules.identity.basis)}
          {rules.identity.fields.length > 0 && (
            <>
              {' · '}
              <Mono className="text-xs">{rules.identity.fields.join(', ')}</Mono>
            </>
          )}
          <div className="text-xs text-slate-500">{IDENTITY_BASIS[rules.identity.basis]}</div>
        </dd>
        <dt className="text-slate-500">Fields compared</dt>
        <dd className="text-slate-700">
          {fmtNumber(rules.comparedFields.length)} field(s)
          {transformed.length > 0 && (
            <>
              {' · '}
              {fmtNumber(transformed.length)} with a transformation
            </>
          )}
        </dd>
        <dt className="text-slate-500">Fields not compared</dt>
        <dd className="text-slate-700">{fmtNumber(rules.excludedFields.length)} field(s)</dd>
        <dt className="text-slate-500">Numeric tolerance</dt>
        <dd className="text-slate-700">{rules.numericTolerance}</dd>
        <dt className="text-slate-500">Date and time</dt>
        <dd className="text-slate-700">{rules.dateTimeHandling}</dd>
        <dt className="text-slate-500">References</dt>
        <dd className="text-slate-700">{rules.lookupMatching}</dd>
        <dt className="text-slate-500">Empty and no value</dt>
        <dd className="text-slate-700">
          {rules.emptyEqualsNull.equal ? 'Compared as the same value.' : 'Compared as two values.'}{' '}
          <span className="text-xs text-slate-500">{rules.emptyEqualsNull.reason}</span>
        </dd>
      </dl>
      <button
        type="button"
        className="mt-2 text-xs font-medium text-brand-700 underline"
        onClick={() => setOpen(!open)}
        data-testid={`rules-fields-toggle-${entity}`}
      >
        {open ? 'Hide every field rule' : 'Show every field rule'}
      </button>
      {open && (
        <div className="mt-2 grid gap-4 md:grid-cols-2" data-testid={`rules-fields-${entity}`}>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Compared</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {rules.comparedFields.map((f) => (
                <li key={f.target} className="flex flex-wrap items-baseline gap-1.5">
                  <Mono className="text-xs">{f.source}</Mono>
                  <ArrowRight className="h-3 w-3 text-slate-400" aria-hidden />
                  <Mono className="text-xs">{f.target}</Mono>
                  {f.isLookup && <Pill tone="slate">reference</Pill>}
                  {f.transformations.map((t) => (
                    <Pill key={t} tone="blue">
                      {humanize(t)}
                    </Pill>
                  ))}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Not compared</p>
            {rules.excludedFields.length === 0 ? (
              <p className="mt-1 text-xs text-slate-600">Every source column was compared.</p>
            ) : (
              /*
               * Two columns, not a wrapping row. A reason long enough to wrap put the next field
               * name directly underneath it, so a reader pairing them down the page attached every
               * reason to the wrong column.
               */
              <ul className="mt-1 space-y-1 text-xs">
                {rules.excludedFields.map((f) => (
                  <li key={f.field} className="grid grid-cols-[minmax(8rem,auto)_1fr] items-baseline gap-x-3">
                    <Mono className="text-xs">{f.field}</Mono>
                    <span className="text-slate-600">{f.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Normalized before comparison
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-600">
              {rules.normalization.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One finding, opened.
 *
 * The table row says what the comparison saw. This says which rule produced the finding, what it
 * costs, and what to do next — the three things a reader opened the report for, and the three the row
 * could not hold. Technical detail is last and behind the same disclosure, because the reader who
 * needs the record identifiers is not the reader deciding whether to act.
 */
function FindingDetail({ d }: { d: ValidationDifferenceDto }) {
  const x = explainFinding(d.differenceType);
  return (
    <tr data-testid="finding-detail">
      <td colSpan={7} className="bg-slate-50/70 px-6 py-3">
        <dl className="grid max-w-4xl gap-x-6 gap-y-1 text-sm sm:grid-cols-[9rem_1fr]">
          <dt className="text-slate-500">Finding</dt>
          <dd className="font-medium text-slate-900">{x.label}</dd>
          <dt className="text-slate-500">Severity</dt>
          <dd>
            <StatusBadge status={d.outcome} />
          </dd>
          <dt className="text-slate-500">Dataset</dt>
          <dd className="text-slate-700">
            <Mono className="text-xs">{d.entity}</Mono>
          </dd>
          <dt className="text-slate-500">Record</dt>
          <dd className="text-slate-700">
            <Mono className="text-xs">{d.sourceRecordId ?? d.targetRecordId ?? '—'}</Mono>
          </dd>
          {d.field && (
            <>
              <dt className="text-slate-500">Field</dt>
              <dd className="text-slate-700">
                <Mono className="text-xs">{d.field}</Mono>
              </dd>
            </>
          )}
          {/*
            Shown only where the finding is about a value. A missing record has no pair to compare,
            and two rows reading "no value" ask the reader to work out that they mean nothing here.
          */}
          {x.hasValues && (
            <>
              <dt className="text-slate-500">{x.expectedLabel}</dt>
              <dd className="break-words text-slate-700">
                {d.sourceValue ?? <span className="text-slate-400">no value</span>}
              </dd>
              <dt className="text-slate-500">{x.actualLabel}</dt>
              <dd className="break-words text-slate-700">
                {d.targetValue ?? <span className="text-slate-400">no value</span>}
              </dd>
            </>
          )}
          <dt className="text-slate-500">Rule applied</dt>
          <dd className="text-slate-700">{x.rule}</dd>
          <dt className="text-slate-500">Why it matters</dt>
          <dd className="text-slate-700">{x.consequence}</dd>
          <dt className="text-slate-500">Next action</dt>
          <dd className="font-medium text-slate-900">{x.nextAction}</dd>
          <dt className="text-slate-500">Technical details</dt>
          <dd className="text-xs text-slate-600">
            <div>
              category <Mono className="text-xs">{d.differenceType}</Mono> · severity{' '}
              <Mono className="text-xs">{d.outcome}</Mono>
            </div>
            <div>
              source record <Mono className="text-xs">{d.sourceRecordId ?? 'none'}</Mono> · target record{' '}
              <Mono className="text-xs">{d.targetRecordId ?? 'none'}</Mono>
            </div>
          </dd>
        </dl>
      </td>
    </tr>
  );
}

function RunAccounting({
  accounting,
  migrationRunId,
}: {
  accounting: RecordAccounting | null;
  migrationRunId: string | null;
}) {
  if (!migrationRunId) return null;
  if (!accounting) {
    return (
      <Callout tone="info" title="Per-record accounting was not recorded for this report">
        This report predates the breakdown of what the run created, updated or left alone. Re-run the
        validation to get it. The figures above are unaffected.
      </Callout>
    );
  }
  const written = writtenByRun(accounting);
  const buckets = [
    { key: 'created', value: accounting.created, tone: 'green' as const },
    { key: 'updated', value: accounting.updated, tone: 'green' as const },
    { key: 'unchanged', value: accounting.unchanged, tone: 'default' as const },
    { key: 'skipped', value: accounting.skipped, tone: 'default' as const },
    {
      key: 'failed',
      value: accounting.failed,
      tone: accounting.failed ? ('red' as const) : ('default' as const),
    },
  ];
  return (
    <Card
      title="What this run did with each record"
      subtitle={`${fmtNumber(accountedFor(accounting))} record(s) accounted for · ${fmtNumber(written)} written by this run`}
      data-testid="run-accounting"
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {buckets.map((b) => {
          const meta = METRIC_DEFINITIONS[b.key as keyof typeof METRIC_DEFINITIONS];
          return (
            <Stat
              key={b.key}
              label={meta.label}
              tone={b.tone}
              value={fmtNumber(b.value)}
              hint={meta.definition}
            />
          );
        })}
      </div>
    </Card>
  );
}

export function ValidationReportPage() {
  const { validationId } = useParams();
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Which finding is open. One at a time: the detail is tall, and two of them hide the table. */
  const [openFinding, setOpenFinding] = useState<string | null>(null);
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
          /*
            One badge, not two. "Completed" and "Fail" side by side read as a contradiction: the
            first is the state of the job, the second the verdict on the data, and nobody should
            have to know that to read the page. While it is running the state is the news; once it
            has finished, the verdict is.
          */
          done && v.outcome ? (
            <StatusBadge status={v.outcome} label={OUTCOME_LABELS[v.outcome]} className="text-sm" />
          ) : (
            <StatusBadge status={v.status} />
          )
        }
      />
      {/*
        While it runs.

        It printed the badge and the progress message, and while the job was queued both of them were
        the word "Queued" — a card that said the same thing twice and told a reader nothing about
        what was about to be compared or how long to wait for it.
      */}
      {['QUEUED', 'RUNNING'].includes(v.status) && (
        <Card>
          <div className="flex items-center gap-3 text-sm text-slate-600" data-testid="validation-progress">
            <StatusBadge status={v.status} />
            <span>
              {v.status === 'QUEUED'
                ? `Waiting to start. ${fmtNumber(v.tables.length)} table(s) to compare.`
                : (v.progressMessage ?? 'Comparing records against the source.')}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            This page updates itself. Nothing is recorded until the comparison finishes.
          </p>
        </Card>
      )}
      {v.status === 'FAILED' && <ErrorState error={new Error(`Validation failed: ${v.errorMessage}`)} />}

      {done && s && (
        <div className="space-y-5">
          <Verdict summary={s} outcome={v.outcome} migrationRunId={v.migrationRunId} entities={v.entities} />

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-9">
            <Stat
              label="Tables"
              value={s.tablesValidated}
              hint={`${s.pass} pass · ${s.warning} warn · ${s.fail} fail`}
            />
            <Stat label="Source rows" value={fmtNumber(s.sourceRows)} hint="In the source tables" />
            <Stat
              label="Target rows"
              value={fmtNumber(s.targetRows)}
              hint={
                s.targetRows > s.sourceRows ? 'Includes records that were already there' : 'In the target'
              }
            />
            <Stat
              label={METRIC_DEFINITIONS.written.label}
              value={s.accounting ? fmtNumber(writtenByRun(s.accounting)) : '—'}
              hint={
                s.accounting
                  ? 'Created + updated. Records already in the target are counted below.'
                  : 'Not recorded for this report'
              }
            />
            <Stat
              label="Matched"
              tone="green"
              value={fmtNumber(s.matchedRecords)}
              hint="Identical on both sides"
            />
            <Stat
              label="Missing"
              tone={s.missingRecords ? 'red' : 'default'}
              value={fmtNumber(s.missingRecords)}
              hint="Expected in the target, not found, and the run did not say so"
              onClick={() => {
                setType('MISSING_IN_TARGET');
                setPage(0);
              }}
            />
            <Stat
              label="Failed in the run"
              tone={s.failedInRunRecords ? 'red' : 'default'}
              value={fmtNumber(s.failedInRunRecords)}
              hint="The run reported these; confirmed absent, never compared"
            />
            <Stat
              label="Different"
              tone={s.differentRecords ? 'amber' : 'default'}
              value={fmtNumber(s.differentRecords)}
              hint="Present, but a field value differs"
              onClick={() => {
                setType('VALUE_MISMATCH');
                setPage(0);
              }}
            />
            <Stat
              label="Broken refs"
              tone={s.brokenReferences ? 'red' : 'default'}
              value={fmtNumber(s.brokenReferences)}
              hint="Lookups pointing at a record that is not there"
              onClick={() => {
                setType('BROKEN_REFERENCE');
                setPage(0);
              }}
            />
          </div>

          <CoveragePanel coverage={s.coverage} depth={v.depth} />

          <RunAccounting accounting={s.accounting} migrationRunId={v.migrationRunId} />

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
                  <Th className="text-right">Failed in run</Th>
                  <Th className="text-right">Different</Th>
                  <Th className="text-right">Broken refs</Th>
                  <Th className="text-right">Duplicates</Th>
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
                        <Td className={`text-right tabular-nums ${e.failedInRun ? 'text-red-700' : ''}`}>
                          {fmtNumber(e.failedInRun)}
                        </Td>
                        <Td className={`text-right tabular-nums ${e.different ? 'text-amber-700' : ''}`}>
                          {fmtNumber(e.different)}
                        </Td>
                        <Td className={`text-right tabular-nums ${e.brokenReferences ? 'text-red-700' : ''}`}>
                          {fmtNumber(e.brokenReferences)}
                        </Td>
                        {/*
                          A dash is not a zero here. "No duplicates" and "we could not look for
                          duplicates" are different answers, and the column that shows one must not
                          be read as the other.
                        */}
                        <Td className="text-right tabular-nums">
                          {e.duplicateCoverage?.mode === 'NOT_VERIFIED' ? (
                            <span
                              className="text-xs font-medium text-slate-400"
                              title={e.duplicateCoverage.reason}
                            >
                              not verified
                            </span>
                          ) : (
                            <span className="inline-flex items-center justify-end gap-1.5">
                              <span className={(e.duplicates?.length ?? 0) > 0 ? 'text-amber-700' : ''}>
                                {fmtNumber((e.duplicates ?? []).reduce((n, d) => n + d.occurrences, 0))}
                              </span>
                              {/*
                                A zero here means only as much as the key it was counted over. On the
                                target's own primary key the count is always zero, because the target
                                refuses a repeat by itself — so without this marker the column reads
                                as "no duplicates" when the product only proved "no duplicate primary
                                keys". Read aloud in the tooltip rather than left to be inferred.
                              */}
                              {e.uniqueness && !e.uniqueness.provesBusinessUniqueness && (
                                <span
                                  className="rounded bg-slate-200 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600"
                                  title={e.uniqueness.proves}
                                >
                                  pk only
                                </span>
                              )}
                              {!e.uniqueness && (
                                <span
                                  className="text-[10px] font-medium uppercase tracking-wide text-slate-400"
                                  title="This report predates recording which key the duplicate check grouped on, so what the count proves is not known."
                                >
                                  basis not recorded
                                </span>
                              )}
                            </span>
                          )}
                        </Td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={12} className="bg-slate-50/70 px-6 py-3">
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
                            {e.uncomparedColumns && e.uncomparedColumns.length > 0 && (
                              <div className="mt-3" data-testid={`uncompared-${e.logicalName}`}>
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                  Not compared
                                </p>
                                {/*
                                  Neither equal nor different. These records were compared on every
                                  other column, so they are counted as matched — what could not be
                                  answered is named here rather than guessed at either way.
                                */}
                                <ul className="mt-1 space-y-1 text-sm">
                                  {e.uncomparedColumns.map((c) => (
                                    <li key={c.field} className="flex flex-wrap items-baseline gap-2">
                                      <Mono className="text-xs">{c.field}</Mono>
                                      <span className="text-slate-600">
                                        {fmtNumber(c.records)} record(s) — {c.reason}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {e.duplicates && e.duplicates.length > 0 && (
                              <div className="mt-3" data-testid={`duplicates-${e.logicalName}`}>
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                  Repeated {e.duplicates[0]!.columns.join(' + ')}
                                </p>
                                <ul className="mt-1 space-y-1 text-sm">
                                  {e.duplicates.slice(0, 10).map((d) => (
                                    <li key={d.value} className="flex flex-wrap items-baseline gap-2">
                                      <Mono className="text-xs">{d.value}</Mono>
                                      <span className="text-slate-600">
                                        {fmtNumber(d.occurrences)} records
                                      </span>
                                      {d.attributable === true && (
                                        <Pill tone="amber">this run wrote {d.writtenByThisRun} of them</Pill>
                                      )}
                                      {d.attributable === false && (
                                        <Pill tone="slate">already in the target</Pill>
                                      )}
                                      {d.attributable === null && (
                                        <Pill
                                          tone="slate"
                                          title="Too many records to attribute from a sample"
                                        >
                                          origin unknown
                                        </Pill>
                                      )}
                                      <span className="text-xs text-slate-400">
                                        e.g. {d.sampleIds.slice(0, 3).join(', ')}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                {e.duplicates.length > 10 && (
                                  <p className="mt-1 text-xs text-slate-500">
                                    and {e.duplicates.length - 10} more repeated value(s)
                                  </p>
                                )}
                              </div>
                            )}
                            {e.aggregates && (
                              <AggregatePanel aggregates={e.aggregates} entity={e.logicalName} />
                            )}
                            <FindingBreakdown
                              findings={e.findings}
                              checks={e.checks}
                              entity={e.logicalName}
                            />
                            <RulesPanel rules={e.rules} entity={e.logicalName} />
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
                          'RECORD_FAILED_IN_RUN',
                          'VALUE_LOST',
                          'VALUE_TRUNCATED',
                          'VALUE_MISMATCH',
                          'LOOKUP_MISMATCH',
                          'BROKEN_REFERENCE',
                          'PRE_EXISTING_DIFFERENCE',
                        ] as DifferenceType[]
                      ).map((t) => ({ value: t, label: findingLabel(t) })),
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
                        <Th className="w-8" />
                        <Th>Table</Th>
                        <Th>Record</Th>
                        <Th>Field</Th>
                        {/*
                          Not "source value". On a value comparison the left column holds what the run
                          was supposed to write, which is the source value after its transformations.
                          Calling that the source invites a reader to check it against the source
                          system by hand and find a difference that is correct.
                        */}
                        <Th>Expected</Th>
                        <Th>In target</Th>
                        <Th>Finding</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {diffs.data.items.map((d) => (
                        <Fragment key={d.id}>
                          <tr
                            className="cursor-pointer hover:bg-slate-50"
                            data-testid="difference-row"
                            onClick={() => setOpenFinding(openFinding === d.id ? null : d.id)}
                          >
                            <Td>
                              {openFinding === d.id ? (
                                <ChevronDown className="h-4 w-4 text-slate-400" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-slate-400" />
                              )}
                            </Td>
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
                              <div className="text-[11px] text-slate-500">
                                {findingLabel(d.differenceType)}
                              </div>
                            </Td>
                          </tr>
                          {openFinding === d.id && <FindingDetail d={d} />}
                        </Fragment>
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
