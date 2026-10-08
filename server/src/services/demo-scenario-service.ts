import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  DemoSetupStatus,
  DemoSetupStatusDto,
  EnvironmentDto,
  MigrationPlanDto,
  ProjectDto,
} from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { migrationRuns, organizations, projects, validationRuns } from '../db/schema';
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

const TERMINAL = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'];

/**
 * How many times discovery is asked again before the attempt is called a failure.
 *
 * Discovery either answers with every simulated environment or throws. It is not a thing that
 * gradually becomes true, so there is nothing to poll for and no delay to guess at. These retries
 * exist for the other case — a provider that throws once — and each one re-runs the real operation
 * and re-checks the real condition rather than waiting and hoping.
 */
const DISCOVERY_ATTEMPTS = 3;
/** Between attempts, doubling. Short, because a failure here blocks a sign-in from finishing. */
const DISCOVERY_BACKOFF_MS = 250;

/** The simulated environments the two worked examples are built from. */
const REQUIRED_ENVIRONMENTS = [
  'DeepTrics Development',
  'DeepTrics UAT',
  'DeepTrics QA',
  'Legacy SQL Server (Demo)',
] as const;

export class DemoScenarioService {
  /**
   * The build running for each organization, if any.
   *
   * Keyed by organization, which it was not. A single promise for the whole process meant the second
   * workspace to sign in got back the *first* one's build, returned immediately, and was never built —
   * and since each evaluator sign-in makes its own organization, that workspace stayed empty for ever.
   * The named team sign-in has the opposite problem and needs the same map: several people land in one
   * organization at once, and only one of them should be writing it.
   */
  private readonly building = new Map<string, Promise<void>>();

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
    await Promise.allSettled([...this.building.values()]);
  }

  /**
   * Whether this workspace's worked examples are still being built.
   *
   * They are built by running two real migrations, which takes a few seconds, and an evaluator who
   * arrives during that sees a workspace that looks half finished rather than one that is filling
   * in. Saying so costs one small poll and removes the only moment the product looks broken when
   * it is working exactly as intended.
   */
  async status(ctx: RequestContext): Promise<DemoSetupStatusDto> {
    const rows = await this.db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.organizationId, ctx.organizationId), eq(projects.status, 'ACTIVE')));
    const names = new Set(rows.map((r) => r.name));
    /*
     * The examples being present is the authority, not the recorded status.
     *
     * A workspace built before this column existed has no status and its projects are there; reading it
     * as anything but ready would be inventing a problem for a workspace that has none. And a recorded
     * status that disagrees with the projects is a recorded status that is wrong.
     */
    const present = DEMO_SCENARIO_PROJECTS.every((n) => names.has(n));
    const [org] = await this.db
      .select({
        status: organizations.demoSetupStatus,
        detail: organizations.demoSetupDetail,
        attempts: organizations.demoSetupAttempts,
      })
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId));

    const running = this.building.has(ctx.organizationId);
    const status: DemoSetupStatus = present
      ? 'READY'
      : running
        ? 'BUILDING'
        : (org?.status ?? 'PENDING') === 'READY'
          ? // Recorded ready, examples gone: somebody archived them. Not a failure, and not ready.
            'PENDING'
          : ((org?.status ?? 'PENDING') as DemoSetupStatus);

    return {
      status,
      ready: present,
      building: status === 'BUILDING',
      detail: status === 'FAILED' ? (org?.detail ?? 'Setup did not complete.') : null,
      attempts: org?.attempts ?? 0,
      // Worth asking again whenever the examples are not there and nothing is already doing it.
      canRetry: !present && status !== 'BUILDING',
    };
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
    const running = this.building.get(ctx.organizationId);
    if (running) return running;

    const attempt = this.attempt(ctx).finally(() => this.building.delete(ctx.organizationId));
    this.building.set(ctx.organizationId, attempt);
    return attempt;
  }

  /**
   * Asks again for a workspace whose setup did not finish.
   *
   * The whole point of the recorded status: the organization that failed can try again, in place. No
   * signing out, no second workspace, nothing for somebody to abandon and come back to. Returns when
   * the attempt has finished, so the caller can report what happened rather than guess.
   */
  async retry(ctx: RequestContext): Promise<DemoSetupStatusDto> {
    await this.ensure(ctx);
    return this.status(ctx);
  }

  /** One attempt, with its outcome recorded whichever way it goes. */
  private async attempt(ctx: RequestContext): Promise<void> {
    await this.record(ctx, 'BUILDING', null, { countAttempt: true });
    try {
      await this.build(ctx);
      await this.record(ctx, 'READY', null);
    } catch (err) {
      /*
       * Recorded, not swallowed. This used to log and return, which left the workspace indistinguishable
       * from one still working — "not ready, not building", for ever, with nothing able to start it.
       */
      const detail = err instanceof Error ? err.message : 'Setup did not complete.';
      this.logger.error({ err, organizationId: ctx.organizationId }, 'Demo scenarios could not be built');
      await this.record(ctx, 'FAILED', detail);
    }
  }

  /** Writes where this workspace got to, so the next reader does not have to infer it. */
  private async record(
    ctx: RequestContext,
    status: DemoSetupStatus,
    detail: string | null,
    options: { countAttempt?: boolean } = {},
  ): Promise<void> {
    await this.db
      .update(organizations)
      .set({
        demoSetupStatus: status,
        demoSetupDetail: detail,
        demoSetupUpdatedAt: new Date(),
        ...(options.countAttempt ? { demoSetupAttempts: sql`${organizations.demoSetupAttempts} + 1` } : {}),
      })
      .where(eq(organizations.id, ctx.organizationId));
  }

  /**
   * The simulated environments, from a discovery this call made itself.
   *
   * The defect this replaces: the build read the environment list, and treated a non-empty answer as
   * proof that discovery had finished. Discovery inserts the environments one at a time, so a list read
   * while another request was discovering returned some of them — and the build, finding one of its four
   * missing, logged a line and returned. The workspace was then empty for ever.
   *
   * Discovery is idempotent and returns the complete list it just wrote, so asking it directly removes
   * the partial read rather than racing it. The retries below are for the other failure: a provider that
   * throws. Each one re-runs the operation and re-checks the real condition.
   */
  private async requiredEnvironments(ctx: RequestContext): Promise<EnvironmentDto[]> {
    let last = 'Discovery did not return the simulated environments.';
    for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt++) {
      try {
        const envs = await this.environments.discover(ctx);
        const missing = REQUIRED_ENVIRONMENTS.filter((n) => !envs.some((e) => e.displayName === n));
        if (missing.length === 0) return envs;
        last = `The simulated environments are not all present: ${missing.join(', ')} missing.`;
      } catch (err) {
        last = err instanceof Error ? err.message : 'Environment discovery failed.';
      }
      this.logger.warn(
        { attempt, of: DISCOVERY_ATTEMPTS, reason: last, organizationId: ctx.organizationId },
        'Demo setup could not read the simulated environments; asking again',
      );
      if (attempt < DISCOVERY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, DISCOVERY_BACKOFF_MS * 2 ** (attempt - 1)));
      }
    }
    throw new Error(last);
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

    /*
     * The environments this build needs, from a discovery it ran itself rather than from whatever
     * another request had written so far. `requiredEnvironments` throws if they cannot be had, which is
     * the point: an attempt that cannot proceed is a failure somebody can see and retry, not a warning
     * in a log and an empty workspace.
     */
    const envs = await this.requiredEnvironments(ctx);
    const by = (name: string) => envs.find((e) => e.displayName === name)!;
    const dev = by('DeepTrics Development');
    const uat = by('DeepTrics UAT');
    const qa = by('DeepTrics QA');
    const sql = by('Legacy SQL Server (Demo)');

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
