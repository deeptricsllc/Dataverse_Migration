/**
 * The shape of a migration evidence package, as a contract rather than as whatever the writer emits.
 *
 * An evidence package is read by somebody who was not there, possibly years later, possibly with a
 * newer version of this platform. That only works if the format says what it is, so every package
 * carries `evidenceSchemaVersion` — a number that changes when the structure changes, independently
 * of the application version. A reader that does not recognise it should say so rather than guess.
 *
 * What the version is *not*: a promise of backward compatibility. Nothing here reads old packages
 * yet. It is a boundary, so that when something does, there is a number to branch on instead of a
 * guess about which fields a file might have.
 */

/**
 * The current package structure.
 *
 * 1 — the original: summary, metrics, validation, coverage, configuration, connector evidence,
 *     manifest with a SHA-256 per file.
 * 2 — adds chunked record lineage, per-file row counts, and this version field. A reader seeing 1
 *     should expect no `lineage` section and no `rows` on a file entry.
 * 3 — adds the crash-consistency state of every record: three more lineage columns, a `recovery`
 *     section in the manifest, and the `UNRESOLVED` outcome. Nothing in 2 changed meaning. A reader
 *     seeing 2 must not conclude that nothing was unresolved — only that the package cannot say.
 */
export const EVIDENCE_SCHEMA_VERSION = 3;

/**
 * Versions this build can read.
 *
 * 2 is still readable: every field it defined means the same thing in 3. What 3 adds is the recovery
 * state of each record — a v2 package simply has no crash-consistency information, which is different
 * from having none to report, and a reader must not infer "nothing was unresolved" from its absence.
 */
export const SUPPORTED_EVIDENCE_SCHEMA_VERSIONS = [2, 3] as const;

/**
 * Files a package must contain to be an evidence package at all.
 *
 * The test is "could somebody reconstruct what happened from this". Metrics without the definitions
 * in `summary.md` invite misreading; configuration without metrics describes an intention rather
 * than an event. A package missing any of these is incomplete, not merely sparse.
 */
export const REQUIRED_EVIDENCE_FILES = [
  'manifest.json',
  'summary.md',
  'metrics.csv',
  'configuration.json',
  'connector-evidence.csv',
] as const;

/**
 * Files a package contains when the run has them, and legitimately omits otherwise.
 *
 * A run that was never validated has no validation files, and saying so is more honest than an empty
 * one. Lineage is present whenever the run wrote an identity map, which is every executed run.
 */
export const OPTIONAL_EVIDENCE_FILES = [
  'validation.csv',
  'validation-coverage.json',
  'aggregates.csv',
  'readiness.json',
] as const;

/** Lineage is split across files, so it is matched by pattern rather than by name. */
export const LINEAGE_FILE_PATTERN = /^lineage\/part-\d{6}\.csv$/;

export interface EvidenceFileRecord {
  path: string;
  bytes: number;
  sha256: string;
  /** What this file is for, in one sentence, for a reader who has only the manifest. */
  describes: string;
  /** Data rows, excluding the header. Absent for files that are not row-oriented. */
  rows?: number;
}

export interface EvidenceLineageSummary {
  /** Every lineage chunk, in order. */
  files: string[];
  /** Data rows across all chunks. Must equal the sum of the chunks' own counts. */
  totalRows: number;
  /** Rows per chunk, so a reader can check the arithmetic without opening them. */
  rowsPerFile: number[];
  /** How many rows a chunk holds before the next one starts. */
  chunkSize: number;
  /**
   * Records with no target identifier, which is every FAILED record and nothing else.
   *
   * Stated so a reader can tell "this record was never written" from "this file is truncated".
   */
  rowsWithoutTarget: number;
}

/**
 * What a crash left behind, and what became of it.
 *
 * Present from schema 3. A package whose counts are all zero is saying the run had nothing in doubt; a
 * package with no `recovery` section at all is saying it predates the protocol and cannot tell you.
 */
export interface EvidenceRecoverySummary {
  /** Records whose write outcome was never resolved. Zero for a completed run. */
  unresolved: number;
  /** Records a crash left in doubt and reconciliation settled against the target. */
  reconciledAutomatically: number;
  /** Records a person looked at and resolved by hand. */
  reconciledByHand: number;
  /** Records still waiting for a person. */
  awaitingReconciliation: number;
  /** Stated so nobody reads a clean package as a guarantee the protocol was exercised. */
  note: string;
}

export interface EvidenceManifest {
  /** @deprecated Kept for packages written before `evidenceSchemaVersion` existed. */
  schema?: number;
  evidenceSchemaVersion: number;
  generatedAt: string;
  /**
   * Which build wrote this package.
   *
   * A package outlives the deployment that produced it, and "which build made this" is exactly the
   * question somebody asks of an artifact from six months ago — usually because a number in it is
   * disputed. Absent on packages written before this was recorded, which a reader should take as "not
   * known" rather than as "the current build".
   */
  producedBy?: {
    version: string;
    commit: string | null;
    deployment: string;
  };
  run: {
    id: string;
    planName: string;
    projectName: string | null;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    /** How many attempts the run took. One logical migration, however many executions. */
    attempt?: number;
    source: { name: string; connectionType: string };
    target: { name: string; connectionType: string };
  };
  files: EvidenceFileRecord[];
  lineage?: EvidenceLineageSummary;
  /** Present from schema 3. Absent means the package predates the crash-consistency protocol. */
  recovery?: EvidenceRecoverySummary;
  integrity: {
    algorithm: 'sha256';
    proves: string;
    doesNotProve: string;
  };
}

/** Outcomes a lineage row may carry: the canonical five, and nothing invented. */
export const LINEAGE_OUTCOMES = [
  'CREATED',
  'UPDATED',
  'UNCHANGED',
  'SKIPPED',
  'FAILED',
  /** The write may have happened and nobody can prove it either way. Added in schema 3. */
  'UNRESOLVED',
] as const;
export type LineageOutcome = (typeof LINEAGE_OUTCOMES)[number];

/** The columns of a lineage chunk, in order. Shared so the verifier checks what the writer wrote. */
export const LINEAGE_COLUMNS = [
  'Run ID',
  'Attempt',
  'Source table',
  'Source key',
  'Target table',
  'Target key',
  'Outcome',
  'Matched by',
  /** Whether the platform can prove what happened. Added in schema 3. */
  'Write state',
  /** What could have identified the record if the answer was lost. Added in schema 3. */
  'Recovery evidence',
  /** What reconciliation or a person concluded, in words. Added in schema 3. */
  'Recovery note',
] as const;

/**
 * What a verified package does and does not establish, in the words the product is allowed to use.
 *
 * The temptation is to call a package with matching digests "verified" and leave the reader to infer
 * the rest. A digest proves the files have not changed since the manifest was written. It proves
 * nothing about who wrote them, because nothing is signed: anybody who edits a file can recompute
 * its digest and edit the manifest too.
 */
export const INTEGRITY_PROVES =
  'Each file listed in the manifest hashes to the digest recorded there, so a file changed after the package was made no longer matches it, and the lineage row counts add up to the total the manifest declares.';

export const INTEGRITY_DOES_NOT_PROVE =
  'Nothing about who made the package or when, beyond what the package itself says. The manifest is not signed, so somebody who edits a file can recompute its digest and edit the manifest too. This detects accidental change and casual tampering. It is not a cryptographic signature, it establishes neither authenticity nor non-repudiation, and it must not be described as signed, authentic or tamper-proof.';

export type EvidenceVerdict = 'VALID' | 'MODIFIED' | 'INCOMPLETE' | 'UNREADABLE' | 'UNSUPPORTED';

export interface EvidenceProblem {
  /** A stable code, so a caller can act on a specific problem rather than parse a sentence. */
  code:
    | 'NOT_A_ZIP'
    | 'MANIFEST_MISSING'
    | 'MANIFEST_UNREADABLE'
    | 'SCHEMA_VERSION_MISSING'
    | 'SCHEMA_VERSION_UNSUPPORTED'
    | 'REQUIRED_FILE_MISSING'
    | 'FILE_MISSING'
    | 'FILE_EXTRA'
    | 'DIGEST_MISMATCH'
    | 'SIZE_MISMATCH'
    | 'ROW_COUNT_MISMATCH'
    | 'LINEAGE_TOTAL_MISMATCH'
    | 'LINEAGE_FILE_MISSING'
    | 'LINEAGE_COLUMNS_UNEXPECTED'
    | 'LINEAGE_OUTCOME_UNKNOWN';
  /** The file the problem is about, where there is one. */
  path: string | null;
  /** What is wrong, in a sentence somebody can act on. */
  detail: string;
}

export interface EvidenceVerification {
  verdict: EvidenceVerdict;
  /** Null when the manifest could not be read. */
  manifest: EvidenceManifest | null;
  /** Every problem found, not just the first: a reader fixing one wants to see the rest. */
  problems: EvidenceProblem[];
  /** Files checked against a recorded digest. */
  filesChecked: number;
  /** Lineage rows counted while checking, for comparison with the declared total. */
  lineageRowsCounted: number | null;
  proves: string;
  doesNotProve: string;
}

/** The single sentence a caller should show beside a verdict, so it is never read as more than it is. */
export function describeVerdict(result: EvidenceVerification): string {
  switch (result.verdict) {
    case 'VALID':
      return `Internally consistent: ${result.filesChecked} file(s) match the digests recorded in the manifest.`;
    case 'MODIFIED':
      return `${result.problems.length} inconsistency(ies) between this package and its manifest. It has been changed since it was made, or it was not written by this platform.`;
    case 'INCOMPLETE':
      return 'This package is missing files an evidence package must contain, so there is nothing to conclude from what is present.';
    case 'UNSUPPORTED':
      return `This package declares an evidence schema this build does not read (supported: ${SUPPORTED_EVIDENCE_SCHEMA_VERSIONS.join(', ')}).`;
    case 'UNREADABLE':
      return 'This is not a readable evidence package.';
  }
}
