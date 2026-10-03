/**
 * Whether a migration is ready to run, assembled from what the platform already knows.
 *
 * Not a new kind of analysis. Schema discovery, mapping, transformations, relationships, profiling,
 * connector verification, target inspection and duplicate detection each already produce findings;
 * what was missing was one place that says, in order of consequence, what somebody has to decide
 * before pressing the button. Everything here is deterministic — a finding exists because something
 * was observed, and it names what was observed.
 *
 * No finding is speculative. If the platform cannot tell, that is itself a finding with a reason,
 * never a guess dressed as a blocker.
 */

export type ReadinessSeverity = 'BLOCKER' | 'WARNING' | 'INFORMATION';

/**
 * Whether a blocker can be run past, and on whose authority.
 *
 * The distinction is not how serious the finding is — it is whether running is *possible*. A target
 * that cannot be written to is not a risk to accept; the migration will not happen. A table whose
 * resume path cannot recover an interruption is a risk somebody can take with their eyes open.
 *
 * There is deliberately no way to override everything at once. An override names one finding.
 */
export type Overridability = 'NON_OVERRIDABLE' | 'OVERRIDABLE_WITH_EXPLICIT_ACKNOWLEDGEMENT';

export interface ReadinessFinding {
  /** Stable identifier, so an override and an audit entry can name this exact finding. */
  code: string;
  severity: ReadinessSeverity;
  /** Only meaningful for a BLOCKER; warnings and information are acknowledged in bulk as today. */
  overridability: Overridability;
  /** What the finding is about: a table, a column, a connection, or the plan as a whole. */
  object: { kind: 'PLAN' | 'TABLE' | 'COLUMN' | 'CONNECTION' | 'RELATIONSHIP'; name: string } | null;
  /** What was observed, in the platform's own terms. The fact, not the interpretation. */
  evidence: string;
  /** Why that matters for this migration. */
  explanation: string;
  /** What to do about it. Never "contact support". */
  recommendation: string;
  /** Where the finding came from, so a reader can go and look at the same thing. */
  source:
    | 'PLAN_VALIDATION'
    | 'CONNECTOR_VERIFICATION'
    | 'TARGET_INSPECTION'
    | 'SCALE_ENVELOPE'
    | 'RESUME_ANALYSIS'
    | 'DUPLICATE_DETECTION'
    | 'ROLLBACK_MODEL';
}

/** An acknowledgement of one overridable blocker, by the person who accepted it. */
export interface ReadinessOverride {
  code: string;
  /** The object the finding named, so an override of one table does not cover another. */
  object: string | null;
  /** Display name of whoever accepted it. No email, no identifier: enough to attribute, no more. */
  acknowledgedBy: string;
  acknowledgedAt: string;
  /** Why they accepted it, in their words. Required: an override with no reason is a click. */
  reason: string;
}

export type ReadinessVerdict = 'READY' | 'READY_WITH_WARNINGS' | 'BLOCKED' | 'BLOCKED_PENDING_OVERRIDE';

export interface ReadinessAssessment {
  planId: string;
  assessedAt: string;
  verdict: ReadinessVerdict;
  findings: ReadinessFinding[];
  /** Overrides recorded on the plan, whether or not they still match a finding. */
  overrides: ReadinessOverride[];
  counts: { blockers: number; warnings: number; information: number; overridden: number };
  /** The sentence to show beside the verdict. */
  summary: string;
}

/** The key an override has to match. An override of one table must not cover another. */
export function overrideKey(code: string, object: string | null): string {
  return `${code}::${object ?? ''}`;
}

export function findingKey(finding: ReadinessFinding): string {
  return overrideKey(finding.code, finding.object?.name ?? null);
}

/**
 * The verdict, derived from the findings and the overrides rather than set alongside them.
 *
 * `BLOCKED` and `BLOCKED_PENDING_OVERRIDE` are different answers: the first means this migration
 * cannot run, the second means somebody has to decide. Collapsing them would hide which one it is.
 */
export function assessVerdict(
  findings: ReadinessFinding[],
  overrides: ReadinessOverride[],
): { verdict: ReadinessVerdict; counts: ReadinessAssessment['counts']; summary: string } {
  const accepted = new Set(overrides.map((o) => overrideKey(o.code, o.object)));
  const blockers = findings.filter((f) => f.severity === 'BLOCKER');
  const outstanding = blockers.filter((f) => !accepted.has(findingKey(f)));
  const hard = outstanding.filter((f) => f.overridability === 'NON_OVERRIDABLE');
  const warnings = findings.filter((f) => f.severity === 'WARNING');
  const information = findings.filter((f) => f.severity === 'INFORMATION');
  const counts = {
    blockers: blockers.length,
    warnings: warnings.length,
    information: information.length,
    overridden: blockers.length - outstanding.length,
  };

  if (hard.length > 0) {
    return {
      verdict: 'BLOCKED',
      counts,
      summary: `${hard.length} finding(s) prevent this migration from running and cannot be overridden: ${hard
        .map((f) => f.code)
        .join(', ')}.`,
    };
  }
  if (outstanding.length > 0) {
    return {
      verdict: 'BLOCKED_PENDING_OVERRIDE',
      counts,
      summary: `${outstanding.length} finding(s) must be accepted individually before this migration can run: ${outstanding
        .map((f) => f.code)
        .join(', ')}.`,
    };
  }
  if (warnings.length > 0) {
    return {
      verdict: 'READY_WITH_WARNINGS',
      counts,
      summary: `Nothing prevents this migration. ${warnings.length} warning(s) describe what it will do that somebody should expect.`,
    };
  }
  return {
    verdict: 'READY',
    counts,
    summary:
      counts.overridden > 0
        ? `Nothing outstanding. ${counts.overridden} blocker(s) were accepted explicitly and are recorded in the evidence package.`
        : 'Nothing found that should stop or surprise this migration.',
  };
}

export const READINESS_SEVERITY_LABELS: Record<ReadinessSeverity, string> = {
  BLOCKER: 'Blocker',
  WARNING: 'Warning',
  INFORMATION: 'For information',
};
