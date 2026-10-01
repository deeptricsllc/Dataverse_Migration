import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { MigrationPlanDto, ProjectDto } from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { migrationRuns, projects, validationRuns } from '../db/schema';
import type { RequestContext } from './context';
import type { EnvironmentService } from './environment-service';
import type { MigrationRunService } from './migration-run-service';
import type { PlanningService } from './planning-service';
import type { ProjectService } from './project-service';
import type { ValidationService } from './validation-service';

/**
 * The two migrations a prospective customer should find already done when they open the demo.
 *
 * Both are executed by the ordinary engine against the ordinary simulated environments — no
 * fabricated run rows, no hand-written validation verdicts. Whatever the platform actually does
 * with this data is what the demo shows, which is the only version of a demo worth having for a
 * product that sells proof. If a migration here stopped passing, the demo would stop claiming it
 * passed.
 *
 * Story A migrates into DeepTrics UAT, which is seeded empty, so every record is a create and the
 * validation has something unambiguous to confirm. Story B goes from the legacy SQL Server into QA,
 * across two different systems' idea of a key, into a table that already holds data — the case
 * where a migration has real problems and the platform has to explain them.
 */

/** Marks the demo org as already set up. Also the project a buyer reads first. */
export const DEMO_SUCCESS_PROJECT = 'Customer Migration — Successful';
export const DEMO_PROBLEM_PROJECT = 'Customer Migration — Data Quality Issues';

const TERMINAL = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'];

export class DemoScenarioService {
  /** One build at a time per process: two sign-ins at once must not both seed. */
  private building: Promise<void> | null = null;

  constructor(
    private readonly db: AppDb,
    private readonly projects: ProjectService,
    private readonly environments: EnvironmentService,
    private readonly planning: PlanningService,
    private readonly runs: MigrationRunService,
    private readonly validation: ValidationService,
    private readonly logger: Logger,
  ) {}

  /**
   * Puts the shared demo workspace back to the two curated examples and nothing else.
   *
   * Everyone who tries the product signs into the same workspace, so it accumulates whatever
   * anybody was experimenting with — and a prospective customer meets somebody else's half-finished
   * work before they meet the product. Projects that are not the curated ones are archived rather
   * than deleted: archived is reversible and still visible behind "Show archived", and this is a
   * tidy-up, not a right to destroy what somebody was in the middle of.
   */
  /**
   * Waits for any build already under way.
   *
   * A reset wipes the simulated records, and a build that is halfway through writing into them
   * would have its remaining writes land after the wipe — leaving records nobody asked for and a
   * second build reporting most of its work as "already there". Resetting means waiting for the
   * thing currently writing to stop.
   */
  async settle(): Promise<void> {
    await this.building;
  }

  /**
   * Whether this workspace's worked examples are still being built.
   *
   * They are built by running two real migrations, which takes a few seconds, and an evaluator who
   * arrives during that sees a workspace that looks half finished rather than one that is filling
   * in. Saying so costs one small poll and removes the only moment the product looks broken when
   * it is working exactly as intended.
   */
  async status(ctx: RequestContext): Promise<{ building: boolean; ready: boolean }> {
    const rows = await this.db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.organizationId, ctx.organizationId), eq(projects.status, 'ACTIVE')));
    const names = new Set(rows.map((r) => r.name));
    const ready = DEMO_SCENARIO_PROJECTS.every((n) => names.has(n));
    return { ready, building: !ready && this.building !== null };
  }

  async tidy(ctx: RequestContext): Promise<{ archived: number }> {
    const rows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, ctx.organizationId), eq(projects.status, 'ACTIVE')));
    for (const row of rows) await this.projects.archive(ctx, row.id);
    if (rows.length) this.logger.info({ archived: rows.length }, 'Demo workspace tidied');
    return { archived: rows.length };
  }

  /**
   * Builds the scenarios if they are not there. Safe to call on every demo sign-in.
   *
   * Never throws at the caller: a demo that cannot be built is a worse demo, not a broken sign-in.
   */
  async ensure(ctx: RequestContext): Promise<void> {
    if (this.building) return this.building;
    this.building = this.build(ctx)
      .catch((err) => {
        this.logger.error({ err }, 'Demo scenarios could not be built');
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  private async build(ctx: RequestContext): Promise<void> {
    // Active, not merely present: a reset archives the old examples and expects new ones built
    // against the restored records, rather than leaving a report that describes data now gone.
    const [existing] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, ctx.organizationId),
          eq(projects.name, DEMO_SUCCESS_PROJECT),
          eq(projects.status, 'ACTIVE'),
        ),
      );
    if (existing) return;

    // A brand new demo organization has no connections until somebody asks for them, and the
    // scenarios need four. Discovery in DEMO MODE only lists the simulated environments, so doing
    // it here costs nothing and removes an ordering dependency on whichever screen loads first.
    let envs = await this.environments.list(ctx);
    if (envs.length === 0) envs = await this.environments.discover(ctx);
    const by = (name: string) => envs.find((e) => e.displayName === name);
    const dev = by('DeepTrics Development');
    const uat = by('DeepTrics UAT');
    const qa = by('DeepTrics QA');
    const sql = by('Legacy SQL Server (Demo)');
    if (!dev || !uat || !qa || !sql) {
      this.logger.warn('Demo scenarios skipped: the simulated environments are not all present');
      return;
    }

    const started = Date.now();
    await this.successStory(ctx, dev.id, uat.id, dev.displayName, uat.displayName);
    await this.problemStory(ctx, sql.id, qa.id, sql.displayName, qa.displayName);
    this.logger.info({ ms: Date.now() - started }, 'Demo scenarios built');
  }

  // -------------------------------------------------------------------------

  /**
   * Development into UAT: same platform both sides, an empty target, nothing to argue about.
   * Everything is created, and the validation report confirms it record by record.
   */
  private async successStory(
    ctx: RequestContext,
    sourceId: string,
    targetId: string,
    sourceName: string,
    targetName: string,
  ): Promise<void> {
    const project = await this.projects.create(ctx, {
      name: DEMO_SUCCESS_PROJECT,
      kind: 'MIGRATION',
      description:
        'Regions, offices, accounts and their contacts moved from Development into an empty UAT environment, then verified against the source record by record. Regions and offices reference each other, so the references that close the cycle are filled in a second pass.',
      sourceEnvironmentId: sourceId,
      targetEnvironmentId: targetId,
    });
    const plan = await this.planning.create(ctx, {
      name: 'Regions, offices, accounts and contacts',
      sourceEnvironmentId: sourceId,
      targetEnvironmentId: targetId,
      // Regions and offices reference each other, which is on purpose: the pair exercises the
      // deferred second pass, and leaving offices out left the region lookups empty and the run
      // carrying warnings it did not need to carry.
      tables: ['dtx_region', 'dtx_office', 'account', 'contact'],
      projectId: project.id,
    });
    await this.executeAndValidate(ctx, plan, sourceName, targetName);
  }

  /**
   * The legacy SQL Server into QA, which is the migration people actually have.
   *
   * Nothing here is arranged to fail. The problems are the ones already in the fixtures: a customer
   * whose name is only whitespace against a target column that requires a name, a website longer
   * than the column it lands in, and a target that already holds accounts. The plan is configured
   * the way a person would configure it — confirm the table pairings, map the columns, choose a
   * business key because a SQL identity column cannot be carried into Dataverse — and then run.
   */
  private async problemStory(
    ctx: RequestContext,
    sourceId: string,
    targetId: string,
    sourceName: string,
    targetName: string,
  ): Promise<void> {
    const project = await this.projects.create(ctx, {
      name: DEMO_PROBLEM_PROJECT,
      kind: 'MIGRATION',
      description:
        'The legacy SQL Server into QA. The source contradicts what the target requires, so some records cannot be written — this is what the platform says about them.',
      sourceEnvironmentId: sourceId,
      targetEnvironmentId: targetId,
    });
    let plan = await this.planning.create(ctx, {
      name: 'Legacy customers and contacts',
      sourceEnvironmentId: sourceId,
      targetEnvironmentId: targetId,
      tables: ['config.Region', 'dbo.Customer', 'dbo.Contact'],
      projectId: project.id,
    });

    const entityOf = (p: MigrationPlanDto, table: string) => p.entities.find((e) => e.logicalName === table)!;

    // A suggested table pairing is never migrated without somebody confirming it.
    for (const [table, target] of [
      ['config.Region', 'dtx_region'],
      ['dbo.Customer', 'account'],
      ['dbo.Contact', 'contact'],
    ] as const) {
      plan = await this.planning.updateObjectMapping(ctx, plan.id, entityOf(plan, table).id, {
        targetLogicalName: target,
        status: 'CONFIRMED',
      });
    }

    for (const [table, source, target] of [
      ['config.Region', 'RegionName', 'dtx_name'],
      ['config.Region', 'RegionCode', 'dtx_code'],
      ['dbo.Customer', 'CustomerName', 'name'],
      ['dbo.Customer', 'CustomerNumber', 'accountnumber'],
      ['dbo.Customer', 'Email', 'emailaddress1'],
      ['dbo.Customer', 'Phone', 'telephone1'],
      ['dbo.Customer', 'CreditLimit', 'revenue'],
      ['dbo.Customer', 'EmployeeCount', 'numberofemployees'],
      ['dbo.Customer', 'OnCreditHold', 'creditonhold'],
      ['dbo.Customer', 'Notes', 'description'],
      ['dbo.Customer', 'RegionId', 'dtx_regionid'],
      // 200 characters of source into a 100 character target column: a real lossy mapping, left in
      // so the demo shows what the platform says about one.
      ['dbo.Customer', 'Website', 'websiteurl'],
      ['dbo.Contact', 'FirstName', 'firstname'],
      ['dbo.Contact', 'LastName', 'lastname'],
      ['dbo.Contact', 'Email', 'emailaddress1'],
      ['dbo.Contact', 'CustomerId', 'parentcustomerid'],
    ] as const) {
      const entity = entityOf(plan, table);
      const { mappings } = await this.planning.mappings(ctx, plan.id, entity.id);
      const mapping = mappings.find((m) => m.sourceField === source);
      if (!mapping) continue;
      plan = await this.planning.updateMapping(ctx, plan.id, mapping.id, {
        action: 'MAP',
        targetField: target,
      });
    }

    // A SQL identity column and a Dataverse GUID are keys of different systems, so records are
    // matched on a business key instead of pretending the ids are comparable.
    for (const [table, fields] of [
      ['config.Region', ['dtx_code']],
      ['dbo.Customer', ['accountnumber']],
      ['dbo.Contact', ['emailaddress1']],
    ] as const) {
      plan = await this.planning.updateEntity(ctx, plan.id, entityOf(plan, table).id, {
        matchStrategy: 'BUSINESS_KEY',
        alternateKey: null,
        businessKeyFields: [...fields],
      });
    }

    if (plan.blockerCount > 0) {
      // Refusing to run a blocked plan is correct behaviour, so the demo stops here rather than
      // forcing it through. The project still shows the plan and what it is waiting on.
      this.logger.warn(
        { blockers: plan.issues.filter((i) => i.severity === 'BLOCKER').map((i) => i.code) },
        'Demo problem story left unexecuted: the plan still has blockers',
      );
      return;
    }
    await this.executeAndValidate(ctx, plan, sourceName, targetName);
  }

  // -------------------------------------------------------------------------

  private async executeAndValidate(
    ctx: RequestContext,
    plan: MigrationPlanDto,
    sourceName: string,
    targetName: string,
  ): Promise<void> {
    const run = await this.runs.start(ctx, plan.id, {
      confirmSourceName: sourceName,
      confirmTargetName: targetName,
      acknowledgeWarnings: true,
    });
    const finished = await this.waitFor(() =>
      this.db
        .select({ status: migrationRuns.status })
        .from(migrationRuns)
        .where(eq(migrationRuns.id, run.id))
        .then(([r]) => (r && TERMINAL.includes(r.status) ? r.status : null)),
    );
    if (!finished) {
      this.logger.warn({ runId: run.id }, 'Demo migration did not finish in time; not validating it');
      return;
    }
    const validation = await this.validation.start(ctx, { migrationRunId: run.id });
    await this.waitFor(() =>
      this.db
        .select({ status: validationRuns.status })
        .from(validationRuns)
        .where(eq(validationRuns.id, validation.id))
        .then(([r]) => (r && TERMINAL.includes(r.status) ? r.status : null)),
    );
  }

  /**
   * Waits for a queued job to reach a terminal state.
   *
   * Polling rather than a subscription because the job is run by the in-process worker through the
   * same queue as everything else, and the demo build is the only thing waiting on it.
   */
  private async waitFor(check: () => Promise<string | null>, timeoutMs = 180_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await check();
      if (status) return status;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }
}

/** Projects the demo builds for itself, so a reset can clear them and build them again. */
export const DEMO_SCENARIO_PROJECTS = [DEMO_SUCCESS_PROJECT, DEMO_PROBLEM_PROJECT] as const;

export type DemoScenarioProject = (typeof DEMO_SCENARIO_PROJECTS)[number];

export type { ProjectDto };
