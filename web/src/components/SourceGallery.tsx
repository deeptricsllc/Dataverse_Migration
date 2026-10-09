import { Database, FileCode, FileSpreadsheet, Plug, Upload, type LucideIcon } from 'lucide-react';
import { cx } from './ui';

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

export type Availability = 'FULL' | 'CONNECTION_ONLY' | 'SIMULATED' | 'COMING_SOON';

export type SourceCategory = 'Files' | 'Databases' | 'Business applications';

export interface Connector {
  id: string;
  name: string;
  category: SourceCategory;
  blurb: string;
  icon: LucideIcon;
  availability: Availability;
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
    blurb: 'Comma, semicolon or tab separated. The usual shape of a legacy export.',
    icon: FileSpreadsheet,
    availability: 'FULL',
    step: 'file',
  },
  {
    id: 'excel',
    name: 'Excel',
    category: 'Files',
    blurb: 'An .xlsx workbook. Choose which sheets you want, so the notes tab stays behind.',
    icon: FileSpreadsheet,
    availability: 'FULL',
    step: 'file',
  },
  {
    id: 'xml',
    name: 'XML',
    category: 'Files',
    blurb: 'A record-per-element export. Attributes and child elements become columns.',
    icon: FileCode,
    availability: 'FULL',
    step: 'file',
  },
  {
    id: 'sqlserver',
    name: 'SQL Server',
    category: 'Databases',
    blurb: 'On-premises or hosted. Verified against real SQL Server instances.',
    icon: Database,
    availability: 'FULL',
    step: 'connection',
    connectionType: 'SQL_SERVER',
  },
  {
    id: 'azuresql',
    name: 'Azure SQL',
    category: 'Databases',
    blurb: 'Azure SQL Database.',
    icon: Database,
    availability: 'SIMULATED',
    caveat:
      'Never run against a real Azure SQL database. Shares a driver with SQL Server, which is not evidence.',
    step: 'connection',
    connectionType: 'AZURE_SQL',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'Databases',
    blurb: 'Verified against real PostgreSQL servers.',
    icon: Database,
    availability: 'FULL',
    step: 'connection',
    connectionType: 'POSTGRES',
  },
  {
    id: 'mysql',
    name: 'MySQL',
    category: 'Databases',
    blurb: 'Verified against real MySQL servers.',
    icon: Database,
    availability: 'FULL',
    step: 'connection',
    connectionType: 'MYSQL',
  },
  {
    id: 'sharepoint',
    name: 'SharePoint',
    category: 'Business applications',
    blurb: 'A list, or a spreadsheet in a document library.',
    icon: Plug,
    availability: 'SIMULATED',
    caveat:
      'Built on Microsoft Graph and tested against a simulator. Never run against a real SharePoint tenant, and it needs a Microsoft sign-in, so a demo workspace cannot reach it.',
    step: 'microsoft',
    connectionType: 'SHAREPOINT',
  },
  {
    id: 'onedrive',
    name: 'OneDrive',
    category: 'Business applications',
    blurb: 'A spreadsheet in your own OneDrive.',
    icon: Plug,
    availability: 'SIMULATED',
    caveat:
      'Built on Microsoft Graph and tested against a simulator. Never run against a real OneDrive, and it needs a Microsoft sign-in, so a demo workspace cannot reach it.',
    step: 'microsoft',
    connectionType: 'ONEDRIVE',
  },
  {
    id: 'dataverse',
    name: 'Microsoft Dataverse',
    category: 'Business applications',
    blurb: 'Dynamics 365 and Power Platform environments.',
    icon: Plug,
    availability: 'SIMULATED',
    caveat: 'Built and tested against a simulator. Never run against a real Dataverse environment.',
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
  blurb: 'Excel (.xlsx), CSV or XML. Added straight to a project, with no connection to set up.',
  icon: Upload,
  availability: 'FULL',
};

export const AVAILABILITY_CHIP: Record<Availability, { label: string; cls: string } | null> = {
  FULL: null,
  CONNECTION_ONLY: { label: 'Connection only', cls: 'bg-sky-50 text-sky-800 ring-sky-200' },
  SIMULATED: { label: 'Simulated', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  COMING_SOON: { label: 'Coming soon', cls: 'bg-slate-100 text-slate-500 ring-slate-200' },
};

const CATEGORY_ORDER: SourceCategory[] = ['Files', 'Databases', 'Business applications'];

export function SourceGallery({
  connectors,
  onChoose,
  intro,
}: {
  connectors: Connector[];
  onChoose: (connector: Connector) => void;
  intro: string;
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
                  const chip = AVAILABILITY_CHIP[connector.availability];
                  const disabled = connector.availability === 'COMING_SOON';
                  return (
                    <button
                      key={connector.id}
                      type="button"
                      data-testid={`connector-${connector.id}`}
                      disabled={disabled}
                      onClick={() => onChoose(connector)}
                      className={cx(
                        'flex gap-3 rounded-lg border p-3 text-left transition-colors',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
                        disabled
                          ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60'
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
                        <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{connector.blurb}</p>
                        {connector.caveat && (
                          <p
                            className={cx(
                              'mt-1 text-xs leading-relaxed',
                              // A limit and a warning are different things, and reading identically
                              // made the blue "connection only" chip argue with its own explanation.
                              connector.availability === 'SIMULATED' ? 'text-amber-800' : 'text-slate-500',
                            )}
                          >
                            {connector.caveat}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
            </div>
          </section>
        ),
      )}
    </div>
  );
}
