import type { ConnectionType } from './domain';

/**
 * What we have seen each connector do, and what kind of seeing it was.
 *
 * The capability flags next to this (`ConnectorCapabilities`) answer "may the planner use this?".
 * This answers "have we run it, and against what?" — which is the question somebody about to move
 * their data is actually asking.
 *
 * The levels are ordered, and the order is the point: each is a strictly stronger claim than the
 * one below, and nothing may display a level its evidence does not reach.
 *
 * A note on an earlier overclaim, kept because it is why this file is shaped this way. PostgreSQL
 * schema discovery was marked verified against the real engine on the strength of PGlite —
 * PostgreSQL compiled to WebAssembly. PGlite runs genuine `pg_catalog` and is excellent
 * compatibility evidence, but it is linked into the test process: no server, no wire protocol, no
 * `pg` driver, no authentication, no network. Those are exactly the layers a customer's deployment
 * has, and exactly where connectors break. That is `ENGINE_COMPATIBLE`, a level of its own, and it
 * is not `ENGINE_VERIFIED`.
 */

export const VERIFICATION_LEVELS = [
  'NOT_SUPPORTED',
  'REQUIRES_CONFIGURATION',
  'SIMULATED',
  'UNIT_TESTED',
  'IMPLEMENTED',
  'ENGINE_COMPATIBLE',
  'ENGINE_VERIFIED',
  'ENVIRONMENT_VERIFIED',
] as const;

export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** Higher is a stronger claim. Used so a summary cannot round a weak row up to a strong one. */
export function levelRank(level: VerificationLevel): number {
  return VERIFICATION_LEVELS.indexOf(level);
}

export const VERIFICATION_LABELS: Record<
  VerificationLevel,
  { label: string; meaning: string; evidence: string }
> = {
  NOT_SUPPORTED: {
    label: 'Not supported',
    meaning: 'Deliberately absent.',
    evidence: 'A design decision, not a gap in testing.',
  },
  REQUIRES_CONFIGURATION: {
    label: 'Needs configuration',
    meaning: 'Available once network access or tenant consent is in place.',
    evidence: 'Cannot be exercised without something only the customer can supply.',
  },
  SIMULATED: {
    label: 'Simulated only',
    meaning: 'Exercised against our simulator, which behaves like the real thing and is not it.',
    evidence: 'Simulator tests. No real instance of the product has been reached.',
  },
  UNIT_TESTED: {
    label: 'Unit tested',
    meaning: 'The logic is tested in isolation — queries, quoting, type mapping.',
    evidence: 'Unit tests. No database of any kind was involved.',
  },
  IMPLEMENTED: {
    label: 'Implemented',
    meaning: 'Production code exists and passes tests that never reach the real engine.',
    evidence: 'Unit and integration tests against simulators or in-process substitutes.',
  },
  ENGINE_COMPATIBLE: {
    label: 'Engine compatible',
    meaning: 'Run against a genuine build of the engine, but in-process — no server, driver or network.',
    evidence: 'Tests against an embedded build. Proves the SQL and the catalog, not the connection path.',
  },
  ENGINE_VERIFIED: {
    label: 'Engine verified',
    meaning:
      'Run against an actual server of this engine, through the driver and network path the product uses.',
    evidence: 'Automated conformance tests against a real server, recorded with its version.',
  },
  ENVIRONMENT_VERIFIED: {
    label: 'Environment verified',
    meaning:
      'Run against a hosted environment matching how customers deploy it, including its authentication and network behaviour.',
    evidence: 'Conformance tests against a managed or cloud-hosted instance.',
  },
};

export type ConnectorCapabilityKey =
  | 'connect'
  | 'schemaDiscovery'
  | 'profiling'
  | 'read'
  | 'pagination'
  | 'write'
  | 'upsert'
  | 'transformations'
  | 'relationshipDiscovery'
  | 'migration'
  | 'validation'
  | 'duplicateDetection'
  | 'aggregateReconciliation'
  | 'fullValidation'
  | 'rollbackInventory'
  | 'retryResume';

export const CAPABILITY_LABELS: Record<ConnectorCapabilityKey, string> = {
  connect: 'Connection',
  schemaDiscovery: 'Schema discovery',
  profiling: 'Profiling',
  read: 'Read as a source',
  pagination: 'Paged reads',
  write: 'Write as a target',
  upsert: 'Match and update existing records',
  transformations: 'Transformations',
  relationshipDiscovery: 'Relationship discovery',
  migration: 'Migration',
  validation: 'Validation',
  duplicateDetection: 'Duplicate detection',
  aggregateReconciliation: 'Totals reconciled by the database',
  fullValidation: 'Full (uncapped) validation',
  rollbackInventory: 'Rollback inventory',
  retryResume: 'Retry and resume',
};

/**
 * Capabilities the real-engine conformance suite can actually demonstrate.
 *
 * The rest — transformations, validation, rollback inventory, resume — live in the engine above the
 * connector. They are exercised thoroughly, but against the connector contract rather than against
 * any particular database, so calling them engine-verified would be borrowing credit.
 */
export const ENGINE_PROVABLE: readonly ConnectorCapabilityKey[] = [
  'connect',
  'schemaDiscovery',
  'profiling',
  'read',
  'pagination',
  'write',
  'upsert',
  'relationshipDiscovery',
  'duplicateDetection',
  'aggregateReconciliation',
];

export type VerificationRow = Partial<Record<ConnectorCapabilityKey, VerificationLevel>>;

const ALL = (level: VerificationLevel): VerificationRow => ({
  connect: level,
  schemaDiscovery: level,
  profiling: level,
  read: level,
  pagination: level,
  write: level,
  upsert: level,
  transformations: level,
  relationshipDiscovery: level,
  migration: level,
  validation: level,
  duplicateDetection: level,
  aggregateReconciliation: level,
  fullValidation: level,
  rollbackInventory: level,
  retryResume: level,
});

/**
 * The ten capabilities the conformance suite can demonstrate, raised together.
 *
 * Together because they are proved by one run against one server: a suite that reached the schema
 * also connected, and one that wrote also read. Splitting them would invite promoting a row the
 * evidence does not separately cover.
 */
const engineVerified = (): VerificationRow =>
  Object.fromEntries(ENGINE_PROVABLE.map((k) => [k, 'ENGINE_VERIFIED' as const]));

/**
 * Capabilities the conformance suite now exercises but no recorded hosted run has yet proved.
 *
 * The suite asserting something and a server having answered are different facts, and this file
 * states the second. A capability sits here from the moment the test is written until a hosted
 * engines run writes PASSED into `evidence/engine-verification.json`; then it comes out and the
 * matrix test checks the claim against that evidence. Raising it early is the one shortcut that
 * would make every other level in this file worth nothing.
 */
const AWAITING_EVIDENCE: VerificationRow = {
  aggregateReconciliation: 'IMPLEMENTED',
};

const READ_ONLY_SOURCE = {
  write: 'NOT_SUPPORTED',
  upsert: 'NOT_SUPPORTED',
  rollbackInventory: 'NOT_SUPPORTED',
  relationshipDiscovery: 'NOT_SUPPORTED',
} as const;

/**
 * Transformations run in the engine above the connector — the same `transformField` for every
 * provider, exercised directly — so their level is a statement about our code, not a database.
 */
const TRANSFORMS = { transformations: 'IMPLEMENTED' } as const;

/**
 * The matrix, at connector × capability granularity.
 *
 * Nothing is promoted because something else passed. Each row claims what that row's evidence
 * supports, and `tests/unit/connector-verification.test.ts` refuses any ENGINE_VERIFIED cell the
 * recorded conformance evidence does not back.
 *
 * The SQL engines start at IMPLEMENTED here and are raised by evidence, not by editing this file in
 * hope: `npm run verify:engines` runs the conformance suite against real servers and writes what
 * passed into `evidence/engine-verification.json`.
 */
export const CONNECTOR_VERIFICATION: Partial<Record<ConnectionType, VerificationRow>> = {
  POSTGRES: { ...ALL('IMPLEMENTED'), ...TRANSFORMS, ...engineVerified(), ...AWAITING_EVIDENCE },
  SQL_SERVER: { ...ALL('IMPLEMENTED'), ...TRANSFORMS, ...engineVerified(), ...AWAITING_EVIDENCE },
  MYSQL: { ...ALL('IMPLEMENTED'), ...TRANSFORMS, ...engineVerified(), ...AWAITING_EVIDENCE },
  /**
   * Azure SQL shares SQL Server's implementation, and sharing an implementation is not evidence.
   * What differs is everything around the query — Entra authentication, firewall rules, enforced
   * encryption, transient faults, throttling — which is the part most likely to break a connection
   * and the part a local container cannot exercise. It inherits nothing automatically.
   */
  AZURE_SQL: { ...ALL('IMPLEMENTED'), ...TRANSFORMS, connect: 'REQUIRES_CONFIGURATION' },
  DATAVERSE: {
    ...ALL('SIMULATED'),
    ...TRANSFORMS,
    connect: 'REQUIRES_CONFIGURATION',
    // No grouping query we will stand behind without a tenant to try it on, so a report says NOT
    // VERIFIED for this table rather than passing it.
    duplicateDetection: 'NOT_SUPPORTED',
    // Nor an aggregate one. FetchXML can total a column, but only within an aggregate row limit it
    // silently stops at, which is the opposite of what a reconciliation is for.
    aggregateReconciliation: 'NOT_SUPPORTED',
  },
  /**
   * The file connector has no external engine: its storage is the platform's own database and the
   * journeys upload real files through the real import path. There is nothing further to verify it
   * against, which is why it is the one connector already at the top of its own ladder.
   */
  FILE: {
    ...ALL('ENGINE_VERIFIED'),
    ...READ_ONLY_SOURCE,
    transformations: 'IMPLEMENTED',
    // Staged files are read into the platform's own tables, and nothing totals them in place.
    aggregateReconciliation: 'NOT_SUPPORTED',
  },
  ONEDRIVE: {
    ...ALL('IMPLEMENTED'),
    ...TRANSFORMS,
    ...READ_ONLY_SOURCE,
    connect: 'REQUIRES_CONFIGURATION',
    aggregateReconciliation: 'NOT_SUPPORTED',
  },
  SHAREPOINT: {
    ...ALL('IMPLEMENTED'),
    ...TRANSFORMS,
    ...READ_ONLY_SOURCE,
    connect: 'REQUIRES_CONFIGURATION',
    aggregateReconciliation: 'NOT_SUPPORTED',
  },
};

export function verificationFor(
  type: ConnectionType,
  capability: ConnectorCapabilityKey,
): VerificationLevel | null {
  return CONNECTOR_VERIFICATION[type]?.[capability] ?? null;
}

/**
 * The weakest level across a connector's capabilities.
 *
 * Deliberately pessimistic, and deliberately not an average. A connector with nine verified
 * capabilities and one simulated one has a simulated capability in it, and the summary somebody
 * glances at must not hide which.
 */
export function summaryLevel(type: ConnectionType): VerificationLevel | null {
  const row = CONNECTOR_VERIFICATION[type];
  if (!row) return null;
  const levels = Object.values(row).filter((l): l is VerificationLevel => Boolean(l));
  // Capabilities absent by design say nothing about how well the rest was tested.
  const meaningful = levels.filter((l) => l !== 'NOT_SUPPORTED' && l !== 'REQUIRES_CONFIGURATION');
  if (meaningful.length === 0) return levels[0] ?? null;
  return meaningful.reduce((worst, l) => (levelRank(l) < levelRank(worst) ? l : worst));
}
