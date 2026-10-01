import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { MigrationPlanDto, PlanIssue } from '../../../shared/domain';
import {
  CONNECTOR_VERIFICATION,
  VERIFICATION_LABELS,
  type ConnectorCapabilityKey,
} from '../../../shared/connector-verification';
import {
  assessVerdict,
  overrideKey,
  type ReadinessAssessment,
  type ReadinessFinding,
  type ReadinessOverride,
} from '../../../shared/readiness';
import type { AppDb } from '../db/client';
import { migrationPlans } from '../db/schema';
import type { AuditService } from './audit-service';
import type { RequestContext } from './context';
import type { PlanningService } from './planning-service';

/**
 * One assessment of whether a migration should run, from evidence that already exists.
 *
 * The platform has had deterministic findings for a long time — forty-odd plan validation codes, a
 * connector verification matrix, a measured scale envelope, duplicate detection, target inspection.
 * What it did not have was one answer to "should we press the button", with each finding naming what
 * was observed, why it matters and what to do.
 *
 * Nothing here invents a finding. Every one of them points at something a reader can go and look at:
 * a plan issue, a row in the verification matrix, a record count, a match strategy. Where the
 * platform cannot tell, that is the finding — never a guess with a severity attached.
 */
export class ReadinessService {
  constructor(
    private readonly db: AppDb,
    private readonly planning: PlanningService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  async assess(ctx: RequestContext, planId: string): Promise<ReadinessAssessment> {
    const plan = await this.planning.revalidate(ctx, planId);
    const overrides = await this.loadOverrides(planId);
    const findings = [
      ...planValidationFindings(plan),
      ...connectorFindings(plan),
      ...targetFindings(plan),
      ...resumeFindings(plan),
      ...scaleFindings(plan),
      ...rollbackFindings(plan),
    ];
    const { verdict, counts, summary } = assessVerdict(findings, overrides);
    return {
      planId,
      assessedAt: new Date().toISOString(),
      verdict,
      findings,
      overrides,
      counts,
      summary,
    };
  }

  /**
   * Accepts one overridable blocker, on the record.
   *
   * Named, reasoned and attributed. There is no bulk form on purpose: a person who accepts six
   * findings has read six findings, and a single button that dismisses a list is the thing this is
   * here to prevent.
   */
  async override(
    ctx: RequestContext,
    planId: string,
    input: { code: string; object: string | null; reason: string },
  ): Promise<ReadinessAssessment> {
    const assessment = await this.assess(ctx, planId);
    const finding = assessment.findings.find(
      (f) => f.code === input.code && (f.object?.name ?? null) === input.object,
    );
    if (!finding) {
      throw new Error(`No current finding ${input.code} for ${input.object ?? 'this plan'}`);
    }
    if (finding.severity !== 'BLOCKER') {
      throw new Error(`${input.code} is a ${finding.severity.toLowerCase()}, which is not overridden`);
    }
    if (finding.overridability === 'NON_OVERRIDABLE') {
      throw new Error(
        `${input.code} cannot be overridden: ${finding.explanation} Running is not possible until it is resolved.`,
      );
    }

    const existing = await this.loadOverrides(planId);
    const next: ReadinessOverride[] = [
      ...existing.filter((o) => overrideKey(o.code, o.object) !== overrideKey(input.code, input.object)),
      {
        code: input.code,
        object: input.object,
        // A display name, not an identifier: enough to attribute, and no more stored than that.
        acknowledgedBy: ctx.displayName ?? 'unknown',
        acknowledgedAt: new Date().toISOString(),
        reason: input.reason,
      },
    ];
    await this.saveOverrides(planId, next);
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'READINESS_BLOCKER_OVERRIDDEN',
      outcome: 'SUCCESS',
      requestId: ctx.requestId,
      details: { planId, code: input.code, object: input.object, reason: input.reason },
    });
    this.logger.warn({ planId, code: input.code, object: input.object }, 'Readiness blocker overridden');
    return this.assess(ctx, planId);
  }

  /** Removes an override, so the finding blocks again. */
  async clearOverride(
    ctx: RequestContext,
    planId: string,
    input: { code: string; object: string | null },
  ): Promise<ReadinessAssessment> {
    const existing = await this.loadOverrides(planId);
    await this.saveOverrides(
      planId,
      existing.filter((o) => overrideKey(o.code, o.object) !== overrideKey(input.code, input.object)),
    );
    await this.audit.record({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'READINESS_OVERRIDE_WITHDRAWN',
      outcome: 'SUCCESS',
      requestId: ctx.requestId,
      details: { planId, code: input.code, object: input.object },
    });
    return this.assess(ctx, planId);
  }

  private async loadOverrides(planId: string): Promise<ReadinessOverride[]> {
    const [row] = await this.db
      .select({ options: migrationPlans.options })
      .from(migrationPlans)
      .where(eq(migrationPlans.id, planId));
    return row?.options?.readinessOverrides ?? [];
  }

  private async saveOverrides(planId: string, overrides: ReadinessOverride[]): Promise<void> {
    const [row] = await this.db
      .select({ options: migrationPlans.options })
      .from(migrationPlans)
      .where(eq(migrationPlans.id, planId));
    if (!row) throw new Error('Plan not found');
    await this.db
      .update(migrationPlans)
      .set({ options: { ...row.options, readinessOverrides: overrides }, updatedAt: new Date() })
      .where(eq(migrationPlans.id, planId));
  }
}

/**
 * Plan validation, as findings.
 *
 * These already block execution today, and they stay non-overridable: each one means a mapping, a
 * key or a dependency that the migration needs and does not have, and letting somebody run past it
 * would turn a refusal into a failure half way through. Relaxing any of them is a decision for
 * whoever owns the product, not a side effect of introducing an override mechanism.
 */
function planValidationFindings(plan: MigrationPlanDto): ReadinessFinding[] {
  return plan.issues
    .filter((i) => !i.acknowledged)
    .map((issue) => ({
      code: issue.code,
      severity:
        issue.severity === 'BLOCKER'
          ? ('BLOCKER' as const)
          : issue.severity === 'WARNING'
            ? ('WARNING' as const)
            : ('INFORMATION' as const),
      overridability: 'NON_OVERRIDABLE' as const,
      object: objectOf(issue),
      evidence: issue.message,
      explanation: explanationFor(issue),
      recommendation: issue.resolution ?? 'Resolve the issue in the plan and re-check readiness.',
      source: 'PLAN_VALIDATION' as const,
    }));
}

function objectOf(issue: PlanIssue): ReadinessFinding['object'] {
  if (issue.field && issue.table) return { kind: 'COLUMN', name: `${issue.table}.${issue.field}` };
  if (issue.table) return { kind: 'TABLE', name: issue.table };
  return { kind: 'PLAN', name: plan_label };
}

const plan_label = 'this plan';

function explanationFor(issue: PlanIssue): string {
  // The message says what was observed; this says what it costs. Only for codes where the
  // consequence is not obvious from the message itself.
  const consequences: Record<string, string> = {
    REQUIRED_TARGET_COLUMN_UNMAPPED:
      'The target refuses a record without this column, so every record in this table would fail.',
    INCOMPATIBLE_COLUMN:
      'The two columns cannot hold the same values, so the migration would either fail or quietly change data.',
    LOSSY_CONVERSION: 'Information present in the source would not exist in the target afterwards.',
    DEPENDENCY_MISSING_IN_TARGET:
      'Records in this table point at a table the target does not have, so their references cannot resolve.',
    DEPENDENCY_NOT_SELECTED:
      'The table this one points at is not in the plan, so the references would be left unresolved.',
    CIRCULAR_DEPENDENCY_TWO_PASS:
      'These tables point at each other, so some references can only be written on a second pass.',
    CROSS_PROVIDER_IDENTITY:
      'The target assigns its own keys, so the identity map is the only record of which source record became which target record.',
    TARGET_HAS_DATA_CREATE_ONLY:
      'The target already holds records, and this strategy will not touch them — so what is there now stays.',
    ALTERNATE_KEY_MISSING:
      'Without the key, there is no way to tell whether a record already exists in the target.',
    BUSINESS_KEY_UNIQUENESS:
      'Two source records share the key, so a match would be a guess about which one owns the target record.',
  };
  return consequences[issue.code] ?? issue.message;
}

/**
 * How far the connectors in this plan have themselves been verified.
 *
 * A clean migration over a connector that has never met the real engine is a weaker statement than
 * the same migration over one that has. Never a blocker — the migration will work or it will not —
 * but somebody choosing to run it should know which of the two they are doing.
 */
function connectorFindings(plan: MigrationPlanDto): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  const sides: { label: string; type: string | null | undefined }[] = [
    { label: 'source', type: plan.sourceEnvironment.connectionType },
    { label: 'target', type: plan.targetEnvironment.connectionType },
  ];
  for (const side of sides) {
    const type = (side.type ?? 'DATAVERSE') as keyof typeof CONNECTOR_VERIFICATION;
    const row = CONNECTOR_VERIFICATION[type];
    if (!row) continue;
    const needed: ConnectorCapabilityKey[] =
      side.label === 'target' ? ['connect', 'write', 'upsert'] : ['connect', 'read', 'pagination'];
    for (const capability of needed) {
      const level = row[capability];
      if (level === 'NOT_SUPPORTED') {
        findings.push({
          code: 'CONNECTOR_CAPABILITY_UNAVAILABLE',
          severity: 'BLOCKER',
          // Nothing to accept: the connector cannot do it, so the migration cannot happen.
          overridability: 'NON_OVERRIDABLE',
          object: {
            kind: 'CONNECTION',
            name: `${plan[`${side.label as 'source' | 'target'}Environment`].displayName}`,
          },
          evidence: `${type} records ${capability} as not supported.`,
          explanation: `A ${side.label} must be able to ${capability}, and this connector cannot.`,
          recommendation: 'Choose a different connection for this side of the migration.',
          source: 'CONNECTOR_VERIFICATION',
        });
      } else if (level && level !== 'ENGINE_VERIFIED' && level !== 'ENVIRONMENT_VERIFIED') {
        findings.push({
          code: 'CONNECTOR_NOT_ENGINE_VERIFIED',
          severity: 'WARNING',
          overridability: 'OVERRIDABLE_WITH_EXPLICIT_ACKNOWLEDGEMENT',
          object: {
            kind: 'CONNECTION',
            name: plan[`${side.label as 'source' | 'target'}Environment`].displayName,
          },
          evidence: `${type} ${capability} is ${VERIFICATION_LABELS[level]}, not verified against a real engine.`,
          explanation: `This capability is implemented and tested against the connector contract, and has not been exercised against a real ${type} server in continuous integration.`,
          recommendation:
            'Treat the first run against this connection as the verification. Keep the scope small and validate at FULL depth.',
          source: 'CONNECTOR_VERIFICATION',
        });
      }
    }
  }
  return findings;
}

/** What is already in the target, which decides what several other numbers will mean. */
function targetFindings(plan: MigrationPlanDto): ReadinessFinding[] {
  const populated = plan.entities.filter((e) => (e.targetCount ?? 0) > 0);
  if (populated.length === 0) return [];
  return [
    {
      code: 'TARGET_ALREADY_POPULATED',
      severity: 'WARNING',
      overridability: 'OVERRIDABLE_WITH_EXPLICIT_ACKNOWLEDGEMENT',
      object: { kind: 'PLAN', name: plan.targetEnvironment.displayName },
      evidence: `${populated.length} target table(s) already hold records: ${populated
        .slice(0, 5)
        .map((e) => `${e.targetLogicalName} (${e.targetCount})`)
        .join(', ')}${populated.length > 5 ? ', …' : ''}.`,
      explanation:
        'Records this run did not write will be in the target alongside the ones it did, so a row count comparison cannot be read as a result, and aggregate reconciliation will report NOT VERIFIED rather than compare two totals that mean different things.',
      recommendation:
        'Expect the validation report to say so. If the totals matter, migrate into an empty target.',
      source: 'TARGET_INSPECTION',
    },
  ];
}

/**
 * Whether an interrupted run could be recovered, which depends entirely on the match strategy.
 *
 * The finding this product most needed and did not have. Target writes and identity-map writes are
 * two systems with no transaction across them, so a run that dies mid-batch leaves records in the
 * target that the platform has no row for. Resume recovers them by re-matching — unless there is
 * nothing to match on, in which case it creates them again and reports success.
 *
 * See `docs/RESUME_SEMANTICS.md`. It is a blocker because the consequence is duplicate records in a
 * customer's target with nothing in the platform to show it; it is overridable because the migration
 * is perfectly safe as long as it is not interrupted, and that is a risk somebody may accept.
 */
function resumeFindings(plan: MigrationPlanDto): ReadinessFinding[] {
  // Keys are preserved only when both sides are the same provider family; otherwise the target
  // assigns them and the source id matches nothing in it.
  const sameProvider = plan.sourceEnvironment.connectionType === plan.targetEnvironment.connectionType;
  return plan.entities
    .filter((e) => e.matchStrategy === 'PRIMARY_ID' && !sameProvider)
    .map((e) => ({
      code: 'RESUME_CANNOT_RECOVER_INTERRUPTION',
      severity: 'BLOCKER' as const,
      overridability: 'OVERRIDABLE_WITH_EXPLICIT_ACKNOWLEDGEMENT' as const,
      object: { kind: 'TABLE' as const, name: e.logicalName },
      evidence: `${e.logicalName} is matched on the record id, and ${plan.targetEnvironment.displayName} assigns its own keys (${plan.sourceEnvironment.connectionType} to ${plan.targetEnvironment.connectionType}).`,
      explanation:
        'A run interrupted part way through a batch leaves records in the target that the platform has no identity row for. With no key to re-match them by, resuming creates them a second time and reports success.',
      recommendation: `Configure an alternate key or a business key for ${e.logicalName}, which closes the gap completely. If you accept the risk instead, do not interrupt the run, and reconcile the target record count against the identity map before any retry.`,
      source: 'RESUME_ANALYSIS' as const,
    }));
}

/** The measured envelope, and whether this plan is inside it. See `docs/SCALE_ENVELOPE.md`. */
const MEASURED_PER_TABLE = 500_000;

function scaleFindings(plan: MigrationPlanDto): ReadinessFinding[] {
  const beyond = plan.entities.filter((e) => (e.sourceCount ?? 0) > MEASURED_PER_TABLE);
  if (beyond.length === 0) return [];
  return beyond.map((e) => ({
    code: 'BEYOND_MEASURED_SCALE',
    severity: 'WARNING' as const,
    overridability: 'OVERRIDABLE_WITH_EXPLICIT_ACKNOWLEDGEMENT' as const,
    object: { kind: 'TABLE' as const, name: e.logicalName },
    evidence: `${e.logicalName} holds ${(e.sourceCount ?? 0).toLocaleString()} records; the platform's bookkeeping has been measured to ${MEASURED_PER_TABLE.toLocaleString()} per table.`,
    explanation:
      'Everything above that is extrapolated rather than measured. The known costs are flat per record, so the expectation is a longer run rather than a failure — but it is an expectation, not a measurement.',
    recommendation:
      'Validate at STANDARD depth rather than FULL, expect the run to take proportionally longer, and consider a smaller first pass to measure the real rate against these connections.',
    source: 'SCALE_ENVELOPE' as const,
  }));
}

/** What rollback is, said before the migration rather than after somebody asks for one. */
function rollbackFindings(plan: MigrationPlanDto): ReadinessFinding[] {
  return [
    {
      code: 'ROLLBACK_IS_INVENTORY',
      severity: 'INFORMATION',
      overridability: 'OVERRIDABLE_WITH_EXPLICIT_ACKNOWLEDGEMENT',
      object: { kind: 'PLAN', name: plan.name },
      evidence: 'This platform records what it wrote and offers that as a rollback inventory.',
      explanation:
        'There is no automatic destructive undo. Reversing a migration means acting on the inventory — deliberately, with the identity map as the list of what this run put there.',
      recommendation:
        'Before writing to a target you cannot restore, take whatever backup that system offers. The inventory tells you what to undo; it does not undo it.',
      source: 'ROLLBACK_MODEL',
    },
  ];
}
