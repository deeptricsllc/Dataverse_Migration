import type { ConnectionType } from './domain';

/**
 * What we have actually seen each connector do, as opposed to what code exists for it.
 *
 * The capability flags next to this (`ConnectorCapabilities`) answer "may the planner use this?".
 * They are declared per family, so PostgreSQL and MySQL claim the same things as SQL Server. That
 * is fine for deciding whether to offer a button and wrong for telling a customer what we have
 * evidence of, because "there is code for it" and "we have run it against that engine" are
 * different sentences and only one of them is worth anything to somebody about to migrate.
 *
 * Every level below says where the evidence comes from. If a row cannot point at evidence, it is
 * not VERIFIED, however confident anybody is.
 */

export type VerificationLevel =
  /** Exercised against this engine end to end in the test suite, including writes. */
  | 'VERIFIED'
  /** Exercised against the simulator the demo runs on. Real engines are not covered by it. */
  | 'SIMULATED'
  /** The code is there and unit-tested; it has not been run against this engine end to end. */
  | 'IMPLEMENTED'
  /** Deliberately absent. A file is not a migration target, and that is a design decision. */
  | 'NOT_SUPPORTED'
  /** Works once somebody supplies something we cannot supply: network access, a Graph consent. */
  | 'REQUIRES_CONFIGURATION';

export const VERIFICATION_LABELS: Record<VerificationLevel, { label: string; meaning: string }> = {
  VERIFIED: {
    label: 'Verified',
    meaning: 'Run against this engine end to end in our test suite, writes included.',
  },
  SIMULATED: {
    label: 'Simulated only',
    meaning: 'Exercised against the built-in simulator, which behaves like the real thing but is not it.',
  },
  IMPLEMENTED: {
    label: 'Implemented, not verified',
    meaning: 'The code exists and is unit-tested. We have not run it against a real instance.',
  },
  NOT_SUPPORTED: { label: 'Not supported', meaning: 'Deliberately absent.' },
  REQUIRES_CONFIGURATION: {
    label: 'Needs configuration',
    meaning: 'Available once network access or tenant consent is in place.',
  },
};

export type ConnectorCapabilityKey =
  | 'connect'
  | 'schemaDiscovery'
  | 'profiling'
  | 'read'
  | 'write'
  | 'upsert'
  | 'transformations'
  | 'relationshipDiscovery'
  | 'migration'
  | 'validation'
  | 'duplicateDetection'
  | 'fullValidation'
  | 'rollbackInventory'
  | 'retryResume';

export const CAPABILITY_LABELS: Record<ConnectorCapabilityKey, string> = {
  connect: 'Connection',
  schemaDiscovery: 'Schema discovery',
  profiling: 'Profiling',
  read: 'Read as a source',
  write: 'Write as a target',
  upsert: 'Match and update existing records',
  transformations: 'Transformations',
  relationshipDiscovery: 'Relationship discovery',
  migration: 'Migration',
  validation: 'Validation',
  duplicateDetection: 'Duplicate detection',
  fullValidation: 'Full (uncapped) validation',
  rollbackInventory: 'Rollback inventory',
  retryResume: 'Retry and resume',
};

export type VerificationRow = Partial<Record<ConnectorCapabilityKey, VerificationLevel>>;

const ALL: (level: VerificationLevel) => VerificationRow = (level) => ({
  connect: level,
  schemaDiscovery: level,
  profiling: level,
  read: level,
  write: level,
  upsert: level,
  transformations: level,
  relationshipDiscovery: level,
  migration: level,
  validation: level,
  duplicateDetection: level,
  fullValidation: level,
  rollbackInventory: level,
  retryResume: level,
});

const READ_ONLY_SOURCE = {
  write: 'NOT_SUPPORTED',
  upsert: 'NOT_SUPPORTED',
  rollbackInventory: 'NOT_SUPPORTED',
  relationshipDiscovery: 'NOT_SUPPORTED',
} as const;

/**
 * Transformations are engine-level and connector-independent: the same `transformField` runs for
 * every provider and is exercised directly, so it is verified wherever it is offered.
 */
const TRANSFORMS_VERIFIED = { transformations: 'VERIFIED' } as const;

/**
 * The matrix.
 *
 * Two things a reader should know before trusting a row.
 *
 * First, the end-to-end journeys — plan, preflight, migrate, validate, re-run what failed — run
 * against built-in simulators. "Legacy SQL Server (Demo)" is a simulator over the platform's own
 * database, not SQL Server. Those journeys verify the planner, the engine, the identity map and
 * the validation logic thoroughly. They verify nothing about how a real SQL Server behaves.
 *
 * Second, the exception that proves it: PostgreSQL schema discovery is VERIFIED because the
 * catalog queries are run against PGlite, which is PostgreSQL compiled to WebAssembly — real
 * `pg_catalog`, real behaviour. The file connector is VERIFIED because it has no external engine
 * to simulate; its storage is the platform's own database and the journey uploads a real file.
 *
 * Everything else that reaches a real external engine is IMPLEMENTED: the code is there, it is
 * unit-tested, its SQL is checked, and nobody has pointed it at the product it is written for in
 * continuous integration. That is a smaller claim than a tick, and it is the true one.
 */
export const CONNECTOR_VERIFICATION: Partial<Record<ConnectionType, VerificationRow>> = {
  SQL_SERVER: { ...ALL('IMPLEMENTED'), ...TRANSFORMS_VERIFIED },
  AZURE_SQL: { ...ALL('IMPLEMENTED'), ...TRANSFORMS_VERIFIED },
  POSTGRES: {
    ...ALL('IMPLEMENTED'),
    ...TRANSFORMS_VERIFIED,
    // PGlite is PostgreSQL compiled to WebAssembly, so the catalog queries run against the real
    // `pg_catalog` rather than an imitation of it.
    schemaDiscovery: 'VERIFIED',
  },
  MYSQL: { ...ALL('IMPLEMENTED'), ...TRANSFORMS_VERIFIED },
  DATAVERSE: {
    ...ALL('SIMULATED'),
    ...TRANSFORMS_VERIFIED,
    connect: 'REQUIRES_CONFIGURATION',
    // No grouping query we are willing to stand behind without a tenant to try it on, so a report
    // says NOT VERIFIED for this table rather than passing it.
    duplicateDetection: 'NOT_SUPPORTED',
  },
  FILE: {
    ...ALL('VERIFIED'),
    ...READ_ONLY_SOURCE,
  },
  ONEDRIVE: {
    ...ALL('IMPLEMENTED'),
    ...TRANSFORMS_VERIFIED,
    ...READ_ONLY_SOURCE,
    connect: 'REQUIRES_CONFIGURATION',
  },
  SHAREPOINT: {
    ...ALL('IMPLEMENTED'),
    ...TRANSFORMS_VERIFIED,
    ...READ_ONLY_SOURCE,
    connect: 'REQUIRES_CONFIGURATION',
  },
};

/** The levels a buyer should read as "we have seen this work". */
export const EVIDENCED: ReadonlySet<VerificationLevel> = new Set<VerificationLevel>(['VERIFIED']);

export function verificationFor(
  type: ConnectionType,
  capability: ConnectorCapabilityKey,
): VerificationLevel | null {
  return CONNECTOR_VERIFICATION[type]?.[capability] ?? null;
}
