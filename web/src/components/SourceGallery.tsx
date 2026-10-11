import { Database, FileCode, FileSpreadsheet, Plug, Upload, type LucideIcon } from 'lucide-react';
import type { ConnectionType } from '@shared/domain';
import { CONNECTOR_VERIFICATION, ENGINE_PROVABLE, summaryLevel } from '@shared/connector-verification';
import { Disclosure, cx } from './ui';

/**
 * The one list of what this product can read, and how real each of those claims is.
 *
 * It lived inside the add-dataset drawer, which is where a user in a project meets it. The
 * connections screen had its own flat list of radio buttons, built from a different array, and the
 * two disagreed: the drawer grouped sources, described them, and marked the simulated ones; the
 * connections screen listed seven names in a grid and left out files entirely. A person who opened
 * Connections looking for "upload a spreadsheet" found no such thing and concluded the product
 * could not do it.
 *
 * One definition, two surfaces. A connector added here appears in both, with the same words and the
 * same honesty about whether it has ever been run against a real system.
 */

/**
 * How far each source has actually been proved, in the four kinds the product can tell apart.
 *
 * Derived from `CONNECTOR_VERIFICATION`, which is the evidence matrix the conformance suite writes
 * into and a unit test polices. The gallery used to carry its own hand-written `availability`, and
 * a hand-written claim beside a measured one drifts: Azure SQL, OneDrive and SharePoint were all
 * labelled "Simulated" here while the matrix recorded them as implemented and never run live,
 * which is a different and more accurate thing to say.
 *
 * LOCAL_FILE is not a weaker rung of the same ladder. A spreadsheet is not an external system that
 * might be unreachable; it is read by this product, from your computer, through a path the
 * journeys exercise on every run. It gets its own word so nothing implies a CSV is a live
 * integration.
 */
export type Availability = 'LOCAL_FILE' | 'LIVE_VERIFIED' | 'NOT_LIVE_VERIFIED' | 'SIMULATED';

export type SourceCategory = 'Files' | 'Databases' | 'Business applications';

export interface Connector {
  id: string;
  name: string;
  category: SourceCategory;
  blurb: string;
  icon: LucideIcon;
  /** What the state means for this connector, in one line. Required for anything short of `FULL`. */
  caveat?: string;
  /** Which step of the add-dataset drawer this opens. Absent for cards that only exist elsewhere. */
  step?: 'file' | 'connection' | 'microsoft';
  connectionType?: string;
}

/**
 * What this product can actually read today.
 *
 * `Simulated` is on the card, not in a footnote. Dataverse has never been executed against a real
 * environment — see docs/DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md — and a gallery that
 * showed it identically to CSV would be the most expensive kind of lie this product could tell,
 * because somebody would plan around it.
 */
export const CONNECTORS: Connector[] = [
  {
    id: 'csv',
    name: 'CSV',
    category: 'Files',
    blurb: 'Comma, semicolon or tab separated. Read from your computer, not from a server.',
    icon: FileSpreadsheet,
    step: 'file',
  },
  {
    id: 'excel',
    name: 'Excel',
    category: 'Files',
    blurb: 'An .xlsx workbook from your computer. Choose the sheets you want, so the notes tab stays behind.',
    icon: FileSpreadsheet,
    step: 'file',
  },
  {
    id: 'xml',
    name: 'XML',
    category: 'Files',
    blurb: 'A record-per-element file from your computer. Attributes and child elements become columns.',
    icon: FileCode,
    step: 'file',
  },
  {
    id: 'sqlserver',
    name: 'SQL Server',
    category: 'Databases',
    blurb: 'On-premises or hosted.',
    caveat: 'Conformance suite passed against SQL Server 2022 through the tedious driver.',
    icon: Database,
    step: 'connection',
    connectionType: 'SQL_SERVER',
  },
  {
    id: 'azuresql',
    name: 'Azure SQL',
    category: 'Databases',
    blurb: 'Azure SQL Database.',
    icon: Database,
    caveat:
      'Implemented and never run against a real Azure SQL database. It shares a driver with SQL Server, and sharing an implementation is not evidence: Entra sign-in, firewall rules and throttling are what differ, and they are what break a connection.',
    step: 'connection',
    connectionType: 'AZURE_SQL',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'Databases',
    blurb: 'Self-hosted or managed.',
    caveat: 'Conformance suite passed against PostgreSQL 16 through the pg driver.',
    icon: Database,
    step: 'connection',
    connectionType: 'POSTGRES',
  },
  {
    id: 'mysql',
    name: 'MySQL',
    category: 'Databases',
    blurb: 'MySQL 8 or MariaDB.',
    caveat: 'Conformance suite passed against MySQL 8.4 through the mysql2 driver.',
    icon: Database,
    step: 'connection',
    connectionType: 'MYSQL',
  },
  /*
   * SharePoint is two cards because it is two things to the person choosing.
   *
   * A document library holds spreadsheets, which is a file source and belongs beside the other
   * ways of getting a spreadsheet in. A list is a table in a business application and belongs
   * beside Dataverse. Both reach the same connection and the same step, which then offers
   * whichever the site actually has; splitting them is about where somebody looks, not about what
   * the connector does.
   */
  {
    id: 'onedrive',
    name: 'OneDrive',
    category: 'Files',
    blurb: 'A spreadsheet in your own OneDrive.',
    icon: Plug,
    caveat:
      'Implemented on Microsoft Graph and never run against a real OneDrive. It needs a Microsoft sign-in, so a demo workspace cannot reach it.',
    step: 'microsoft',
    connectionType: 'ONEDRIVE',
  },
  {
    id: 'sharepoint-library',
    name: 'SharePoint document library',
    category: 'Files',
    blurb: 'A spreadsheet stored in a SharePoint document library.',
    icon: Plug,
    caveat:
      'Implemented on Microsoft Graph and never run against a real SharePoint tenant. It needs a Microsoft sign-in, so a demo workspace cannot reach it.',
    step: 'microsoft',
    connectionType: 'SHAREPOINT',
  },
  {
    id: 'sharepoint-lists',
    name: 'SharePoint lists',
    category: 'Business applications',
    blurb: 'A list, with its columns and items, as a dataset.',
    icon: Plug,
    caveat:
      'Implemented on Microsoft Graph and never run against a real SharePoint tenant. It needs a Microsoft sign-in, so a demo workspace cannot reach it.',
    step: 'microsoft',
    connectionType: 'SHAREPOINT',
  },
  {
    id: 'dataverse',
    name: 'Microsoft Dataverse',
    category: 'Business applications',
    blurb: 'Dynamics 365 and Power Platform environments.',
    icon: Plug,
    caveat:
      'Exercised only against our Dataverse simulator, which behaves like the real thing and is not it. Never run against a real Dataverse environment.',
    step: 'connection',
    connectionType: 'DATAVERSE',
  },
];

/**
 * The card the connections screen shows in place of the three file formats.
 *
 * A spreadsheet on somebody's laptop is not reusable authenticated access to a system, so it is not
 * a connection, and the original screen expressed that by offering no file option at all. The
 * distinction is real and the silence was not a way to teach it. The card says where files go and
 * takes the user there.
 */
export const UPLOAD_FROM_COMPUTER: Connector = {
  id: 'upload',
  name: 'Upload from your computer',
  category: 'Files',
  blurb:
    'Excel (.xlsx), CSV or XML from your computer. Added straight to a project, with no connection to set up.',
  icon: Upload,
};

export const AVAILABILITY_CHIP: Record<Availability, { label: string; cls: string } | null> = {
  LOCAL_FILE: { label: 'Local file', cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
  LIVE_VERIFIED: { label: 'Live verified', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  NOT_LIVE_VERIFIED: { label: 'Not live verified', cls: 'bg-sky-50 text-sky-800 ring-sky-200' },
  SIMULATED: { label: 'Simulated', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
};

/**
 * The status for a connector, read from the evidence matrix rather than asserted here.
 *
 * ENGINE_VERIFIED means the conformance suite ran against a real server of that engine, through
 * the driver and network path the product uses, and recorded the version it saw. Anything below
 * that has not been run live, whatever else is true of it.
 */
export function availabilityOf(connector: {
  connectionType?: string;
  category: SourceCategory;
}): Availability {
  /*
   * Local means local, not "filed under Files".
   *
   * OneDrive and a SharePoint document library are grouped with files because that is where a
   * person looks for a spreadsheet, and they are still remote systems reached over Graph with a
   * Microsoft sign-in. Keying this off the category badged both of them "Local file", which is a
   * claim about where the data lives and it was false. A card with no connection type is the local
   * one: there is no system to connect to, because the file is on your computer.
   */
  const type = connector.connectionType as ConnectionType | undefined;
  if (!type || type === 'FILE') return 'LOCAL_FILE';
  /*
   * Judged on the capabilities a server can actually prove, not on every row.
   *
   * `summaryLevel` takes the worst level in the matrix, and `transformations` sits at IMPLEMENTED
   * for every connector by design: transformations run in the engine above the connector, so their
   * level is a statement about our code rather than about anybody's database. Including it dragged
   * SQL Server, PostgreSQL and MySQL down to "Not live verified" while the conformance evidence
   * recorded ten of ten passing against real servers.
   */
  const row = CONNECTOR_VERIFICATION[type];
  if (!row) return 'NOT_LIVE_VERIFIED';
  const provable = ENGINE_PROVABLE.map((k) => row[k]).filter(
    (l): l is NonNullable<typeof l> => Boolean(l) && l !== 'NOT_SUPPORTED',
  );
  if (provable.length > 0 && provable.every((l) => l === 'ENGINE_VERIFIED' || l === 'ENVIRONMENT_VERIFIED'))
    return 'LIVE_VERIFIED';
  if (summaryLevel(type) === 'SIMULATED') return 'SIMULATED';
  return 'NOT_LIVE_VERIFIED';
}

const CATEGORY_ORDER: SourceCategory[] = ['Files', 'Databases', 'Business applications'];

/** What each status means, said once at the bottom rather than on every card. */
const STATUS_NOTES: { label: string; meaning: string }[] = [
  { label: 'Local file', meaning: 'Read from your computer. Nothing is connected to.' },
  {
    label: 'Live verified',
    meaning:
      'The conformance suite passed against a real server of this engine, through the driver this product uses. The card names the version.',
  },
  {
    label: 'Not live verified',
    meaning:
      'Built and tested, and never pointed at a real instance. Sign-in, firewall rules and throttling are what differ and they are what break a connection.',
  },
  {
    label: 'Simulated',
    meaning: 'Exercised only against our simulator, which behaves like the real thing and is not it.',
  },
];

export function SourceGallery({
  connectors,
  onChoose,
  intro,
  unavailable,
}: {
  connectors: Connector[];
  onChoose: (connector: Connector) => void;
  intro: string;
  /**
   * Connectors that cannot be used in this particular role, with the reason.
   *
   * Shown greyed with the reason rather than quietly dropped. A file is a perfectly good migration
   * source and can never be a migration target, and somebody looking for it in the target picker
   * deserves to be told that rather than left to wonder whether they missed it.
   */
  unavailable?: (connector: Connector) => string | null;
}) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-600">{intro}</p>
      {CATEGORY_ORDER.filter((category) => connectors.some((c) => c.category === category)).map(
        (category) => (
          <section key={category}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{category}</h3>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {connectors
                .filter((c) => c.category === category)
                .map((connector) => {
                  const Icon = connector.icon;
                  const availability = availabilityOf(connector);
                  const chip = AVAILABILITY_CHIP[availability];
                  const blocked = unavailable?.(connector) ?? null;
                  return (
                    <button
                      key={connector.id}
                      type="button"
                      data-testid={`connector-${connector.id}`}
                      disabled={Boolean(blocked)}
                      onClick={() => onChoose(connector)}
                      className={cx(
                        'flex gap-3 rounded-lg border p-3 text-left transition-colors',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
                        blocked
                          ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-70'
                          : 'border-slate-200 bg-white hover:border-brand-300 hover:bg-brand-50/30',
                      )}
                    >
                      <Icon className="mt-0.5 h-5 w-5 flex-none text-slate-400" aria-hidden />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold text-slate-900">{connector.name}</span>
                          {chip && (
                            <span
                              className={cx(
                                'rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset',
                                chip.cls,
                              )}
                            >
                              {chip.label}
                            </span>
                          )}
                        </div>
                        {/*
                          One line. The verification narrative used to sit here, three or four
                          sentences of it on half the cards, which made a grid of nine options into
                          a page of reading and buried the one about uploading a spreadsheet. It is
                          still shown, in the step that follows choosing, and summarised below.
                        */}
                        <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{connector.blurb}</p>
                        {blocked && <p className="mt-1 text-xs leading-relaxed text-slate-500">{blocked}</p>}
                      </div>
                    </button>
                  );
                })}
            </div>
          </section>
        ),
      )}
      <Disclosure summary="What these labels mean">
        <dl className="space-y-2 text-xs leading-relaxed text-slate-600">
          {STATUS_NOTES.map((n) => (
            <div key={n.label}>
              <dt className="font-semibold text-slate-800">{n.label}</dt>
              <dd>{n.meaning}</dd>
            </div>
          ))}
        </dl>
      </Disclosure>
    </div>
  );
}
