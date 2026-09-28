import type { AuthConfigDto } from '@shared/domain';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Boxes,
  CalendarClock,
  Check,
  ChevronDown,
  Database,
  Fingerprint,
  FlaskConical,
  KeyRound,
  Layers,
  ListChecks,
  Lock,
  Mail,
  Repeat2,
  Route,
  ScanSearch,
  Server,
  ShieldCheck,
  Table2,
  Workflow,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AccessRequestForm } from '../components/AccessRequestForm';
import { get } from '../lib/api';
import { useDemoLogin } from '../lib/session';

/**
 * The public front door.
 *
 * Everything claimed on this page is something the product does today. Where a capability is
 * bounded, unverified or absent, the page says so rather than leaving it out — hence the "what it
 * does not do yet" section. The first question a serious evaluator asks is what the gaps are, and
 * answering before they ask is worth more than the paragraph it costs.
 */

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
  className = '',
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-20 px-6 py-20 sm:py-24 ${className}`}>
      <div className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          {eyebrow && (
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-brand-600">{eyebrow}</p>
          )}
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{title}</h2>
          {lead && <p className="mt-4 text-lg leading-relaxed text-slate-600">{lead}</p>}
        </div>
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

function Feature({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Check;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <h3 className="mt-4 text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{children}</p>
    </div>
  );
}

function Faq({ question, children }: { question: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-slate-200 py-5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-6 text-left"
      >
        <span className="text-base font-semibold text-slate-900">{question}</span>
        <ChevronDown
          className={`h-5 w-5 flex-none text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      {open && <div className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-600">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The hero illustration: what a preflight reports
// ---------------------------------------------------------------------------

const TILES = [
  { label: 'Create', value: '41,902', tone: 'text-emerald-300', bar: 'bg-emerald-400' },
  { label: 'Update', value: '3,118', tone: 'text-sky-300', bar: 'bg-sky-400' },
  { label: 'Unchanged', value: '1,996', tone: 'text-slate-300', bar: 'bg-slate-400' },
  { label: 'Conflict', value: '12', tone: 'text-amber-300', bar: 'bg-amber-400' },
  { label: 'Blocked', value: '255', tone: 'text-rose-300', bar: 'bg-rose-400' },
];

const BLOCKERS = [
  { reason: 'Owner cannot be resolved in the target', count: '212 records' },
  { reason: 'Two source records share one business key', count: '31 records' },
  { reason: 'Choice value has no equivalent in the target', count: '12 records' },
];

function PreflightVignette() {
  return (
    <figure className="w-full">
      <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-2xl backdrop-blur">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <ScanSearch className="h-4 w-4 text-brand-400" aria-hidden />
            Preflight — dry run
          </div>
          <span className="rounded-full bg-emerald-400/15 px-2.5 py-1 text-[11px] font-bold tracking-wide text-emerald-300">
            NOTHING WRITTEN
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-5 gap-2">
          {TILES.map((t) => (
            <div key={t.label} className="rounded-lg bg-white/5 p-2.5">
              <dt className="truncate text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {t.label}
              </dt>
              <dd className={`mt-1 text-sm font-bold tabular-nums sm:text-base ${t.tone}`}>{t.value}</dd>
              <div className={`mt-1.5 h-1 rounded-full ${t.bar}`} />
            </div>
          ))}
        </dl>
        <div className="mt-4 space-y-1.5">
          {BLOCKERS.map((b) => (
            <div
              key={b.reason}
              className="flex items-center justify-between gap-3 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2"
            >
              <span className="min-w-0 truncate text-xs text-rose-100">{b.reason}</span>
              <span className="flex-none text-[11px] font-semibold tabular-nums text-rose-300">
                {b.count}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-4 flex items-center gap-2 text-[11px] text-slate-400">
          <Check className="h-3.5 w-3.5 flex-none text-emerald-400" aria-hidden />
          These numbers are exact — every record was read.
        </p>
      </div>
      <figcaption className="mt-3 text-center text-xs text-slate-500">
        The preflight summary: every source record classified and every blocker named, before anything is
        written.
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const SOURCES = [
  { name: 'Microsoft Dataverse', write: true, note: 'Batching, throttling, impersonation' },
  { name: 'SQL Server', write: true, note: 'On-premises or hosted' },
  { name: 'Azure SQL', write: true, note: 'Shares the SQL Server connector' },
  { name: 'PostgreSQL', write: true, note: 'Verified against real PostgreSQL' },
  { name: 'MySQL / MariaDB', write: true, note: 'Driver path needs your server to verify' },
  { name: 'CSV / Excel / XML upload', write: false, note: 'Types inferred, with the reason for each' },
  { name: 'OneDrive / SharePoint file', write: false, note: 'Not yet run against a real tenant' },
  { name: 'SharePoint list', write: false, note: 'Not yet run against a real tenant' },
];

const LIFECYCLE = [
  {
    icon: ScanSearch,
    name: 'Analyse',
    text: 'Profile every column, and find what the source contradicts about itself.',
  },
  { icon: Table2, name: 'Map', text: 'In the app, or export a workbook and map it in Excel.' },
  { icon: Layers, name: 'Plan', text: 'Load order worked out from the real foreign keys.' },
  { icon: Workflow, name: 'Transform', text: 'Clean in flight. The source is never modified.' },
  {
    icon: ListChecks,
    name: 'Preflight',
    text: 'A dry run that classifies every record and writes nothing.',
  },
  {
    icon: Route,
    name: 'Migrate',
    text: 'Streaming, resumable, idempotent. Pause and retry survive a restart.',
  },
  { icon: ShieldCheck, name: 'Validate', text: 'The target compared against the source, independently.' },
  { icon: CalendarClock, name: 'Schedule', text: 'Keep it correct as the source keeps changing.' },
];

const GAPS = [
  {
    title: 'Rollback is an inventory, not an execution',
    text: 'We show everything a run created, in reverse dependency order, and we do not delete it. We do not capture before-images yet, so an updated record could not be restored — and auto-deleting production data on an incomplete picture would be worse than refusing.',
  },
  {
    title: 'No DELETE synchronisation',
    text: 'The platform never deletes in a target. A record removed from the source is not removed from the destination.',
  },
  {
    title: 'MySQL is verified in pieces, not end to end',
    text: 'Quoting, parameter binding, the type vocabulary and catalog-to-metadata are covered. The conversation with a live server is one environment variable away from being covered too: point the connector contract suite at your MySQL and it runs.',
  },
  {
    title: 'On-premises needs a network path',
    text: 'A hosted deployment cannot reach a server behind your firewall. The outbound agent is designed and not built, so today the answer is a network route or a self-hosted deployment.',
  },
];

const PILOT_NEEDS: [string, string][] = [
  ['A source and a target', 'and a network path to both.'],
  ['A service account per system', 'read-only is enough for the entire analysis half.'],
  ['A non-production target first', 'the product assumes this and enforces it for members.'],
];

export function LandingPage() {
  const config = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => get<AuthConfigDto>('/api/auth/config'),
  });
  const demo = useDemoLogin('/');
  const demoEnabled = config.data?.demoEnabled ?? false;
  const signUpEnabled = config.data?.signUpEnabled ?? false;
  const contactEmail = config.data?.contactEmail ?? null;

  const demoButton = (variant: 'primary' | 'quiet') =>
    demoEnabled && (
      <button
        type="button"
        data-testid={`try-demo-${variant}`}
        onClick={() => demo.mutate()}
        disabled={demo.isPending}
        className={
          variant === 'primary'
            ? 'inline-flex items-center justify-center gap-2 rounded-lg bg-amber-400 px-5 py-3 text-sm font-semibold text-amber-950 shadow-lg shadow-amber-900/30 transition-colors hover:bg-amber-300 disabled:opacity-70'
            : 'inline-flex items-center justify-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950 transition-colors hover:bg-amber-300 disabled:opacity-70'
        }
      >
        <FlaskConical className="h-4 w-4" aria-hidden />
        {demo.isPending ? 'Preparing environments…' : 'Try the live demo'}
      </button>
    );

  return (
    <div className="min-h-full bg-white">
      {/* ------------------------------------------------------------------ */}
      {/* Navigation                                                         */}
      {/* ------------------------------------------------------------------ */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-brand-600">
              <Boxes className="h-5 w-5 text-white" aria-hidden />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-white">Data Analysis &amp; Migration Platform</div>
              <div className="text-[11px] text-slate-400">by DeepTrics</div>
            </div>
          </div>
          <nav className="hidden items-center gap-6 text-sm text-slate-300 lg:flex" aria-label="Sections">
            <a className="hover:text-white" href="#how">
              How it works
            </a>
            <a className="hover:text-white" href="#trust">
              Why trust the numbers
            </a>
            <a className="hover:text-white" href="#sources">
              Sources
            </a>
            <a className="hover:text-white" href="#security">
              Security
            </a>
            <a className="hover:text-white" href="#faq">
              FAQ
            </a>
          </nav>
          <div className="flex flex-none items-center gap-2">
            <Link
              to="/login"
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-200 hover:bg-white/10 hover:text-white"
            >
              Sign in
            </Link>
            {demoButton('quiet')}
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Hero                                                               */}
      {/* ------------------------------------------------------------------ */}
      <div className="relative overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-brand-900">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 right-0 h-[32rem] w-[32rem] rounded-full bg-brand-600/20 blur-3xl"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2 lg:py-28">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-slate-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
              Analysis and migration, in one platform
            </span>
            <h1 className="mt-6 text-4xl font-bold leading-[1.1] tracking-tight text-white sm:text-5xl">
              Know exactly what a migration will do.{' '}
              <span className="text-brand-300">Before it does it.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-300">
              Profile any source down to the column. Map it in the app or in Excel. Then run a dry run that
              reads every record and classifies it — create, update, unchanged, conflict, blocked — while
              writing nothing at all. Afterwards, prove independently what happened.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {demoButton('primary')}
              <Link
                to="/login"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/10"
              >
                {signUpEnabled ? 'Sign in with Microsoft' : 'Sign in'}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <a
                href="#request"
                className="inline-flex items-center justify-center gap-2 px-2 py-3 text-sm font-semibold text-slate-300 hover:text-white"
              >
                Request access
              </a>
            </div>
            <p className="mt-5 max-w-lg text-sm text-slate-400">
              {demoEnabled
                ? 'The demo is the whole product, running on deliberately messy simulated data. No install, no tenant connection, nothing to configure.'
                : 'Sign in with your Microsoft work account, or ask us for access.'}
            </p>
          </div>
          <PreflightVignette />
        </div>

        <div className="relative border-t border-white/10 bg-slate-950/50">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-6 gap-y-2 px-6 py-5 text-xs font-medium text-slate-400">
            <span className="text-slate-500">Reads and writes:</span>
            <span>Microsoft Dataverse</span>
            <span>SQL Server</span>
            <span>Azure SQL</span>
            <span>PostgreSQL</span>
            <span>MySQL</span>
            <span className="text-slate-500">Reads:</span>
            <span>CSV, Excel &amp; XML</span>
            <span>OneDrive</span>
            <span>SharePoint</span>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* The problem                                                        */}
      {/* ------------------------------------------------------------------ */}
      <Section
        eyebrow="Why this exists"
        title="Migrations rarely fail loudly."
        lead="They succeed, and months later somebody finds out what the success cost. Each of these is a decision a person would have made differently if anyone had told them."
        className="bg-slate-50"
      >
        <div className="grid gap-6 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden />
            <h3 className="mt-4 font-semibold text-slate-900">The field was longer than its destination</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              A note column of 160 characters into one that holds 100. Almost every record fitted.
              Thirty-eight did not, and quietly lost their last sentence.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <Fingerprint className="h-5 w-5 text-violet-500" aria-hidden />
            <h3 className="mt-4 font-semibold text-slate-900">The owner could not be resolved</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              So everything became the service account. Every record is present, and the audit trail now says
              one robot created the entire customer base.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <Ban className="h-5 w-5 text-rose-500" aria-hidden />
            <h3 className="mt-4 font-semibold text-slate-900">The run reported COMPLETED</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              One table had failed outright. No individual record failed, so nothing contradicted the word
              COMPLETED — and the next person read it and moved on.
            </p>
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Two kinds of project                                               */}
      {/* ------------------------------------------------------------------ */}
      <Section
        id="product"
        eyebrow="One platform, two kinds of work"
        title="Understand a system. Then move it."
        lead="Work lives in a project, and a project is one of two kinds. A migration project can be built from an analysis project, so the mapping starts from measured facts instead of assumptions."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border-t-4 border-[var(--color-source)] bg-white p-7 shadow-sm ring-1 ring-slate-200">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[var(--color-source)]">
              <ScanSearch className="h-4 w-4" aria-hidden /> Data analysis
            </div>
            <h3 className="mt-3 text-xl font-semibold text-slate-900">Find out what is actually in there</h3>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              Connect any supported source and profile it: population and null rates per column, blanks,
              distinct values, lengths and ranges, inferred types with the reason for each, the load order
              implied by real foreign keys, and findings wherever the source contradicts its own schema.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-slate-700">
              {[
                'Run many analyses in one project and compare them over time',
                'Export a mapping workbook to Excel — source facts filled in, target columns left to you',
                'An analysis project has no target and cannot write anywhere. Enforced, not a convention',
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <Check className="mt-0.5 h-4 w-4 flex-none text-[var(--color-source)]" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border-t-4 border-[var(--color-target)] bg-white p-7 shadow-sm ring-1 ring-slate-200">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[var(--color-target)]">
              <Route className="h-4 w-4" aria-hidden /> Data migration
            </div>
            <h3 className="mt-3 text-xl font-semibold text-slate-900">Move it, and prove it moved</h3>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              Import the mapping back from Excel with the destination filled in, or map in the app column by
              column with a compatibility verdict on each. Then preflight, migrate, validate and reconcile —
              and schedule it, because the source does not hold still.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-slate-700">
              {[
                'Matching is deterministic: identity map, primary id, alternate key, business key — never a guess',
                'Idempotent and resumable: run it twice and nothing duplicates',
                'Data loss takes a named acknowledgement, recorded with who accepted it and when',
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <Check className="mt-0.5 h-4 w-4 flex-none text-[var(--color-target)]" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Lifecycle                                                          */}
      {/* ------------------------------------------------------------------ */}
      <Section
        id="how"
        eyebrow="How it works"
        title="Eight steps, and you can stop at any of them."
        lead="Nothing is written until you have seen what writing would do. Each step produces something you can hand to somebody else — a profile, a workbook, a plan, a remediation package, a validation report."
        className="bg-slate-50"
      >
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {LIFECYCLE.map((step, i) => (
            <li key={step.name} className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-slate-900 text-xs font-bold text-white">
                  {i + 1}
                </span>
                <step.icon className="h-4 w-4 flex-none text-brand-600" aria-hidden />
                <span className="font-semibold text-slate-900">{step.name}</span>
              </div>
              <p className="mt-2.5 text-sm leading-relaxed text-slate-600">{step.text}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Trust                                                              */}
      {/* ------------------------------------------------------------------ */}
      <Section
        id="trust"
        eyebrow="The actual claim"
        title="Why the numbers can be trusted."
        lead="This is the part worth scrutinising, because it is what separates this from a tool that copies rows."
      >
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <Feature icon={ListChecks} title="Every statistic says exact or sampled">
            A number counts as exact only when the source gave an exact row count and every record was
            examined. One sampled table makes the whole analysis sampled, and the screen says so. An estimate
            is never presented as a total.
          </Feature>
          <Feature icon={Workflow} title="One transformation engine">
            Preview, preflight, migration and validation all call the same code. If the preview says a value
            becomes 100000000, that is what preflight classifies, what the migration writes and what
            validation compares. A second implementation would let those four disagree.
          </Feature>
          <Feature icon={AlertTriangle} title="Data loss is counted, not estimated">
            A truncation across 145,283 records where 38 exceed the limit reports 38 — the records that
            actually lose information, not the records the rule runs on. Each one is listed with its original
            value and what it becomes.
          </Feature>
          <Feature icon={Layers} title="Where a list is bounded, it says so">
            The counts are always complete. The per-record drill-down is capped, and every screen, package and
            export that hit a cap states how many rows of how many it holds.
          </Feature>
          <Feature icon={ShieldCheck} title="A run reports what actually happened">
            A whole table can fail without a single record failing. Every such signal feeds one decision, so a
            run that lost a table is never stamped COMPLETED and its audit trail never claims success.
          </Feature>
          <Feature icon={Repeat2} title="Validation is independent">
            It does not re-read the migration's own work. It compares the target against the source — row
            counts, record existence, field values, references — and each check either passes or names what
            differs.
          </Feature>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Sources                                                            */}
      {/* ------------------------------------------------------------------ */}
      <Section
        id="sources"
        eyebrow="Connects to"
        title="Databases both ways. Files and lists, read-only."
        lead="Files and SharePoint lists are read-only by construction rather than by omission: the capability reports it, the planner refuses them as targets, no control is rendered to choose one, and the connector's write methods refuse."
        className="bg-slate-50"
      >
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3 font-semibold">Source</th>
                <th className="px-3 py-3 font-semibold">Read</th>
                <th className="px-3 py-3 font-semibold">Write</th>
                <th className="hidden px-5 py-3 font-semibold sm:table-cell">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {SOURCES.map((s) => (
                <tr key={s.name}>
                  <td className="px-5 py-3 font-medium text-slate-900">{s.name}</td>
                  <td className="px-3 py-3">
                    <Check className="h-4 w-4 text-emerald-600" aria-label="yes" />
                  </td>
                  <td className="px-3 py-3">
                    {s.write ? (
                      <Check className="h-4 w-4 text-emerald-600" aria-label="yes" />
                    ) : (
                      <span className="text-xs font-semibold text-slate-400">No</span>
                    )}
                  </td>
                  <td className="hidden px-5 py-3 text-slate-500 sm:table-cell">{s.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 flex items-center gap-2 text-sm text-slate-500">
          <Database className="h-4 w-4 flex-none" aria-hidden />
          Adding a dialect is a connector and a type vocabulary. The rest of the platform does not change.
        </p>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Security                                                           */}
      {/* ------------------------------------------------------------------ */}
      <Section
        id="security"
        eyebrow="Security and control"
        title="Built for somebody else's production data."
        lead="Because that is what it handles."
      >
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <Feature icon={Lock} title="Nothing modifies a source">
            Ever. Cleaning and transformation happen in flight, on the way to the target.
          </Feature>
          <Feature icon={KeyRound} title="Credentials never come back out">
            Encrypted at rest with AES-GCM in a separate table, decrypted only when a connection is opened,
            never returned by the API and never written to a log.
          </Feature>
          <Feature icon={Fingerprint} title="Tenant isolation, tested adversarially">
            Every route is probed by a test acting as another organization's administrator, because isolation
            must not depend on the caller's role.
          </Feature>
          <Feature icon={ShieldCheck} title="Injection is structurally impossible">
            Every value is a bound parameter. Identifiers are resolved against real catalog metadata before
            being quoted, and anything that could not be a real identifier is refused rather than escaped.
          </Feature>
          <Feature icon={Server} title="A read-only switch the server enforces">
            Certification mode allows every read and blocks every write, in the application and again inside
            each connector. A scheduled run cannot get around it.
          </Feature>
          <Feature icon={ListChecks} title="An audit trail for consequential actions">
            Who ran what, against which environments, with which options, and who accepted a data-loss warning
            — with the organization, user and request id on every entry.
          </Feature>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Honest gaps                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section className="bg-slate-900 px-6 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-3xl">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-400">
              What it does not do yet
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              The gaps, before you find them.
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-slate-300">
              A migration tool that oversells itself is worse than one that is narrow. These are the limits we
              would rather you heard from us.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-2">
            {GAPS.map((g) => (
              <div key={g.title} className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <h3 className="font-semibold text-white">{g.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-300">{g.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* FAQ                                                                */}
      {/* ------------------------------------------------------------------ */}
      <Section id="faq" eyebrow="Questions" title="The ones we are always asked.">
        <div className="max-w-4xl">
          <Faq question="Do I need to connect a real tenant to evaluate it?">
            No. The demo runs the entire product against simulated Dataverse environments and a simulated
            legacy SQL Server, seeded with deliberately messy data — a duplicate business key, a broken
            foreign key, an unresolvable owner, a choice value the target does not have. Every problem you see
            is a real problem, found by the product.
          </Faq>
          <Faq question="How large a migration can it handle?">
            The migration itself streams and is never capped or silently truncated. It is resumable: pause,
            cancel and retry survive a worker restart, and a re-run skips everything already migrated. The
            assurance layer — preflight, validation, exports — is bounded, and says so wherever a bound
            applies.
          </Faq>
          <Faq question="How do accounts work?">
            {signUpEnabled
              ? 'There is no separate password to create. Signing in with a Microsoft work account creates your workspace the first time somebody from your tenant arrives, and that first person becomes its administrator. Everyone after them joins the same workspace as a member.'
              : 'Sign-in uses Microsoft Entra ID with your organizational account. This deployment is restricted to approved tenants, so ask us for access and we will enable yours.'}{' '}
            Members plan, analyse, preflight and migrate to non-production. An administrator is needed for
            what outlives the task: writing to production, writing unattended, and deleting shared
            configuration.
          </Faq>
          <Faq question="What happens to our credentials?">
            Microsoft sign-in uses the authorization code flow with PKCE; access tokens stay on the server in
            an encrypted cache, and your Dataverse password is never requested. Database passwords are
            encrypted at rest, decrypted only to open a connection, and no route in the API returns one.
          </Faq>
          <Faq question="Can it keep two systems in step after the first load?">
            Yes, on a schedule you control — cron in a real time zone, so 02:00 stays 02:00 across a clock
            change, reading only what changed since the last successful run. A schedule passes exactly the
            same gates as a person: it will not run a plan with unresolved blockers, it will not perform a
            transformation that discards data unless that was already accepted, and it pauses itself rather
            than repeating a failure all night.
          </Faq>
          <Faq question="Can we self-host it?">
            Yes. It is a single container plus PostgreSQL, with a durable job queue in the database — no Redis
            and no broker to run. It deploys to Railway today and nothing ties it there.
          </Faq>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* Close: demo, pilot, request access                                 */}
      {/* ------------------------------------------------------------------ */}
      <section
        id="request"
        className="scroll-mt-20 bg-gradient-to-br from-slate-950 to-brand-900 px-6 py-20 sm:py-24"
      >
        <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-2">
          <div>
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Start with the demo. Talk to us when it has earned it.
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-slate-300">
              A useful pilot is one table with a real problem in it — a duplicate key, an unresolvable owner,
              a column longer than its destination. This is built to find those, and finding one in your data
              is worth more than a clean run.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">{demoButton('primary')}</div>
            <dl className="mt-10 space-y-4 text-sm">
              {PILOT_NEEDS.map(([term, def]) => (
                <div key={term} className="flex gap-3">
                  <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-400" aria-hidden />
                  <div>
                    <dt className="inline font-semibold text-white">{term} </dt>
                    <dd className="inline text-slate-400">{def}</dd>
                  </div>
                </div>
              ))}
            </dl>
            {contactEmail && (
              <a
                href={`mailto:${contactEmail}`}
                className="mt-8 inline-flex items-center gap-2 text-sm font-medium text-brand-300 hover:text-brand-200"
              >
                <Mail className="h-4 w-4" aria-hidden />
                {contactEmail}
              </a>
            )}
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-7">
            <h3 className="text-lg font-semibold text-white">Request access</h3>
            <p className="mt-1.5 text-sm text-slate-400">
              Tell us what you are moving and we will come back to you. A person reads these.
            </p>
            <div className="mt-6">
              <AccessRequestForm />
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Footer                                                             */}
      {/* ------------------------------------------------------------------ */}
      <footer className="border-t border-slate-800 bg-slate-950 px-6 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 text-sm text-slate-400 sm:flex-row">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-brand-600">
              <Boxes className="h-4 w-4 text-white" aria-hidden />
            </div>
            <span>
              Data Analysis &amp; Migration Platform <span className="text-slate-600">· by DeepTrics</span>
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-5">
            <a className="hover:text-white" href="#product">
              Platform
            </a>
            <a className="hover:text-white" href="#security">
              Security
            </a>
            <a className="hover:text-white" href="#request">
              Request access
            </a>
            <Link className="hover:text-white" to="/login">
              Sign in
            </Link>
          </div>
        </div>
        <p className="mx-auto mt-6 max-w-6xl text-xs leading-relaxed text-slate-600">
          Microsoft, Dataverse, SharePoint, OneDrive, Azure and SQL Server are trademarks of the Microsoft
          group of companies. This product is independent and not endorsed by Microsoft.
        </p>
      </footer>

      {demo.error && (
        <p className="bg-rose-950 px-6 py-3 text-center text-sm text-rose-200" role="alert">
          {demo.error instanceof Error ? demo.error.message : 'Could not start the demo.'}
        </p>
      )}
    </div>
  );
}
