/**
 * How much of the data a validation result actually looked at.
 *
 * A report that says "all checks passed" after comparing fifty thousand of ten million records has
 * told the reader something true about fifty thousand records and something false about the other
 * nine and a half million. The difference between those two statements is the difference between
 * evidence and reassurance, so coverage travels with every result and the wording is derived from
 * it rather than written by hand next to it.
 *
 * Three states, and they must never be presented as equivalent assurance:
 *
 *   FULL          every eligible record was compared
 *   SAMPLED       some were, and the report says how many and how they were chosen
 *   NOT_VERIFIED  the check could not run here, which is not the same as passing
 */

export type CoverageMode = 'FULL' | 'SAMPLED' | 'NOT_VERIFIED';

export interface ValidationCoverage {
  mode: CoverageMode;
  /** Records that could have been examined by this check. */
  eligible: number;
  /** Records actually examined. */
  examined: number;
  /** How those records were chosen, in words a reader can check against the number. */
  strategy: string;
  /** The ceiling that produced a sample, when one applied. */
  cap: number | null;
  /** Whether running it again examines the same records. */
  deterministic: boolean;
  /** Why the check could not run. Only set when mode is NOT_VERIFIED. */
  reason?: string;
}

/**
 * How many records a validation depth will compare per table.
 *
 * Named by what they cost, not by a confidence level: these are caps on work, and no sampling model
 * behind them supports a claim about the records that were not examined. FULL has no cap.
 */
export const VALIDATION_DEPTHS = {
  QUICK: { label: 'Quick', perTable: 500, hint: 'A first look. Fastest, and the least evidence.' },
  STANDARD: {
    label: 'Standard',
    perTable: 5_000,
    hint: 'The default. Enough to find systematic problems without reading everything.',
  },
  FULL: {
    label: 'Full',
    perTable: null,
    hint: 'Every record the run accounted for. The only depth that can report full coverage.',
  },
} as const;

export type ValidationDepth = keyof typeof VALIDATION_DEPTHS;

export const DEFAULT_VALIDATION_DEPTH: ValidationDepth = 'STANDARD';

export function depthCap(depth: ValidationDepth): number | null {
  return VALIDATION_DEPTHS[depth].perTable;
}

/**
 * Records are taken in order of source identifier, so the same depth over the same run examines the
 * same records. That is reproducibility, and it is all it is: a prefix of the identifier order is
 * not a random sample and nothing here pretends it supports an inference about the rest.
 */
export const DETERMINISTIC_PREFIX_STRATEGY =
  'The first records in source-identifier order, so the same depth examines the same records every time.';

export function fullCoverage(
  eligible: number,
  strategy = 'Every record the run accounted for.',
): ValidationCoverage {
  return { mode: 'FULL', eligible, examined: eligible, strategy, cap: null, deterministic: true };
}

export function notVerified(eligible: number, reason: string): ValidationCoverage {
  return {
    mode: 'NOT_VERIFIED',
    eligible,
    examined: 0,
    strategy: 'Not examined.',
    cap: null,
    deterministic: true,
    reason,
  };
}

/** Derives the mode from the counts, so a result cannot claim a coverage its numbers contradict. */
export function coverageOf(input: {
  eligible: number;
  examined: number;
  cap: number | null;
  strategy?: string;
  deterministic?: boolean;
}): ValidationCoverage {
  const { eligible, examined, cap } = input;
  const strategy = input.strategy ?? DETERMINISTIC_PREFIX_STRATEGY;
  const deterministic = input.deterministic ?? true;
  if (eligible === 0) {
    return { mode: 'FULL', eligible: 0, examined: 0, strategy: 'Nothing to examine.', cap, deterministic };
  }
  if (examined === 0) {
    return notVerified(eligible, 'No records were examined.');
  }
  if (examined >= eligible) {
    return { mode: 'FULL', eligible, examined: eligible, strategy, cap, deterministic };
  }
  return { mode: 'SAMPLED', eligible, examined, strategy, cap, deterministic };
}

/** 0–100, rounded so a partial sample never displays as 100%. */
export function coveragePercent(c: ValidationCoverage): number {
  if (c.eligible === 0) return 100;
  const raw = (c.examined / c.eligible) * 100;
  if (raw > 0 && raw < 0.1) return 0.1;
  if (raw < 100 && Math.round(raw) === 100) return 99.9;
  return Math.round(raw * 10) / 10;
}

/**
 * The run-level coverage: the weakest claim any table can support.
 *
 * Deliberately pessimistic. One table validated by sample makes the whole report a sampled report,
 * because the reader is being asked to trust a single verdict.
 */
export function combineCoverage(parts: readonly ValidationCoverage[]): ValidationCoverage {
  if (parts.length === 0) return fullCoverage(0, 'Nothing to examine.');
  const eligible = parts.reduce((n, c) => n + c.eligible, 0);
  const examined = parts.reduce((n, c) => n + c.examined, 0);
  const anyNotVerified = parts.some((c) => c.mode === 'NOT_VERIFIED');
  const anySampled = parts.some((c) => c.mode === 'SAMPLED');
  const mode: CoverageMode = anyNotVerified ? 'NOT_VERIFIED' : anySampled ? 'SAMPLED' : 'FULL';
  const caps = parts.map((c) => c.cap).filter((v): v is number => v !== null);
  return {
    mode,
    eligible,
    examined,
    strategy: parts[0]?.strategy ?? DETERMINISTIC_PREFIX_STRATEGY,
    cap: caps.length ? Math.max(...caps) : null,
    deterministic: parts.every((c) => c.deterministic),
    ...(anyNotVerified
      ? { reason: parts.find((c) => c.mode === 'NOT_VERIFIED')?.reason ?? 'Some checks did not run.' }
      : {}),
  };
}

/**
 * The sentence a result is allowed to make about itself.
 *
 * Every success message in the product goes through this, so none of them can say "everything
 * matches" over a sample. `subject` is what was compared, e.g. "records" or "lookup references".
 */
export function describeCoverage(c: ValidationCoverage, subject = 'records'): string {
  if (c.mode === 'NOT_VERIFIED') return `Not verified — ${c.reason ?? 'this check could not run here.'}`;
  if (c.eligible === 0) return `No ${subject} to examine.`;
  if (c.mode === 'FULL') return `All ${c.eligible.toLocaleString()} ${subject} were examined.`;
  return `${c.examined.toLocaleString()} of ${c.eligible.toLocaleString()} ${subject} examined (${coveragePercent(c)}%).`;
}

/** The headline a passing result may use. Never "all checks passed" over a sample. */
export function describeClean(c: ValidationCoverage, subject = 'records'): string {
  if (c.mode === 'NOT_VERIFIED') return describeCoverage(c, subject);
  if (c.eligible === 0) return `Nothing to check.`;
  if (c.mode === 'FULL') return `No differences in any of the ${c.eligible.toLocaleString()} ${subject}.`;
  return `No differences found in the ${c.examined.toLocaleString()} ${subject} examined, of ${c.eligible.toLocaleString()}.`;
}
