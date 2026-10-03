import { and, eq } from 'drizzle-orm';
import type {
  EnvironmentDto,
  MigrationPlanDto,
  MigrationRunDto,
  ValidationRunDto,
} from '../../shared/domain';
import type { ValidationDepth } from '../../shared/validation-coverage';
import type { ReadinessAssessment } from '../../shared/readiness';
import { demoRecords } from '../../server/src/db/schema';
import { ApiClient, createTestApp, type TestApp } from '../helpers';

/**
 * The Golden Journeys: the handful of connected workflows that have to work, every release.
 *
 * These exist because of a pattern the earlier phases kept repeating — hundreds of green tests, and a
 * workflow still broken end to end. The file-migration chain was five separate bugs, each in code that
 * had passing tests, and the chain was what nobody ran. A unit test proves a function; a journey proves
 * that the product does the thing a customer bought it for.
 *
 * Two rules keep them worth having:
 *
 *   1. **Verify the target independently.** Every journey checks the rows in the target directly,
 *      through `targetRows` below, not through the counters the engine wrote or the report the product
 *      produced. A migration that duplicated every record can report perfect numbers; only counting
 *      the target catches it. Where a journey asserts a number the product calculated, it also asserts
 *      the thing that number is about.
 *   2. **Do not assert UI text.** These run at the API and database level. The screens have their own
 *      coverage in `e2e/`; a journey that broke when a label changed would be deleted within a month.
 *
 * They run in the ordinary `npm test`, so they are release gates rather than something to remember.
 */

export interface Journey {
  t: TestApp;
  api: ApiClient;
  worker: ReturnType<TestApp['services']['createWorker']>;
  organizationId: string;
  /** The simulated environments: a source, and three targets of increasing strictness. */
  dev: EnvironmentDto;
  qa: EnvironmentDto;
  uat: EnvironmentDto;
  close: () => Promise<void>;
}

export async function openJourney(overrides: Record<string, string> = {}): Promise<Journey> {
  const t = await createTestApp(overrides);
  const api = new ApiClient(t.app);
  const worker = t.services.createWorker();
  const session = await api.demoLogin();
  const envs = await api.post<EnvironmentDto[]>('/api/environments/discover');
  const byName = (name: string) => {
    const found = envs.find((e) => e.displayName === name);
    if (!found) throw new Error(`the demo workspace has no environment called ${name}`);
    return found;
  };
  return {
    t,
    api,
    worker,
    organizationId: session.user.organization.id,
    dev: byName('DeepTrics Development'),
    qa: byName('DeepTrics QA'),
    uat: byName('DeepTrics UAT'),
    close: async () => {
      await worker.stop();
      await t.close();
    },
  };
}

/** Which storage key an environment's records live under. */
export const envKeyOf = (env: EnvironmentDto): string => {
  const map: Record<string, string> = {
    'DeepTrics Development': 'demo-dev',
    'DeepTrics QA': 'demo-qa',
    'DeepTrics UAT': 'demo-uat',
    'DeepTrics Production': 'demo-prod',
  };
  const key = map[env.displayName];
  if (!key) throw new Error(`no storage key known for ${env.displayName}`);
  return key;
};

/**
 * The rows actually in the target, read straight from storage.
 *
 * This is the independent check. It does not go through the connector that wrote them, the engine's
 * counters, or the validation report — so a migration that wrote every record twice, or wrote nothing
 * and said it wrote everything, is caught here and nowhere else.
 */
export async function targetRows(
  j: Journey,
  env: EnvironmentDto,
  logicalName: string,
): Promise<{ recordId: string; data: Record<string, unknown> }[]> {
  const rows = await j.t.services.db
    .select({ recordId: demoRecords.recordId, data: demoRecords.data })
    .from(demoRecords)
    .where(
      and(
        eq(demoRecords.organizationId, j.organizationId),
        eq(demoRecords.environmentKey, envKeyOf(env)),
        eq(demoRecords.logicalName, logicalName),
      ),
    );
  return rows as { recordId: string; data: Record<string, unknown> }[];
}

/** Adds rows to a simulated environment, for a journey that needs data the demo does not have. */
export async function seedRows(
  j: Journey,
  env: EnvironmentDto,
  logicalName: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const values = rows.map((data) => ({
    organizationId: j.organizationId,
    environmentKey: envKeyOf(env),
    logicalName,
    recordId: String(data[`${logicalName}id`] ?? data.id ?? crypto.randomUUID()),
    data,
  }));
  for (let i = 0; i < values.length; i += 500) {
    await j.t.services.db.insert(demoRecords).values(values.slice(i, i + 500));
  }
}

export interface PlanRequest {
  name: string;
  source: EnvironmentDto;
  target: EnvironmentDto;
  tables: string[];
  batchSize?: number;
  /** Applied to every entity in the plan. */
  match?: {
    matchStrategy: 'PRIMARY_ID' | 'ALTERNATE_KEY' | 'BUSINESS_KEY';
    businessKeyFields?: string[];
    alternateKey?: string | null;
  };
}

export async function createPlan(j: Journey, request: PlanRequest): Promise<MigrationPlanDto> {
  const plan = await j.api.post<MigrationPlanDto>('/api/plans', {
    name: `${request.name} ${Date.now()}`,
    sourceEnvironmentId: request.source.id,
    targetEnvironmentId: request.target.id,
    tables: request.tables,
  });
  if (request.batchSize) await j.api.patch(`/api/plans/${plan.id}/options`, { batchSize: request.batchSize });
  if (request.match) {
    const full = await j.api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
    for (const entity of full.entities) {
      await j.api.patch(`/api/plans/${plan.id}/entities/${entity.id}`, {
        alternateKey: null,
        businessKeyFields: [],
        ...request.match,
      });
    }
  }
  return j.api.get<MigrationPlanDto>(`/api/plans/${plan.id}`);
}

export async function readiness(j: Journey, planId: string): Promise<ReadinessAssessment> {
  return j.api.get<ReadinessAssessment>(`/api/plans/${planId}/readiness`);
}

export async function execute(j: Journey, plan: MigrationPlanDto): Promise<MigrationRunDto> {
  // The confirmation the product asks for: the names have to be typed back, so a journey types them
  // back from the plan rather than from the environment it happened to pick.
  const started = await j.api.post<MigrationRunDto>(`/api/plans/${plan.id}/execute`, {
    confirmSourceName: plan.sourceEnvironment.displayName,
    confirmTargetName: plan.targetEnvironment.displayName,
    acknowledgeWarnings: true,
  });
  await j.worker.drain(300_000);
  return j.api.get<MigrationRunDto>(`/api/runs/${started.id}`);
}

export async function retry(j: Journey, runId: string): Promise<MigrationRunDto> {
  await j.api.post(`/api/runs/${runId}/retry`, {});
  await j.worker.drain(300_000);
  return j.api.get<MigrationRunDto>(`/api/runs/${runId}`);
}

export async function validate(
  j: Journey,
  runId: string,
  depth: ValidationDepth = 'FULL',
): Promise<ValidationRunDto> {
  const started = await j.api.post<ValidationRunDto>('/api/validations', {
    migrationRunId: runId,
    depth,
  });
  await j.worker.drain(300_000);
  return j.api.get<ValidationRunDto>(`/api/validations/${started.id}`);
}

/** One row per source record the run handled, parsed from the lineage export the product serves. */
export async function lineage(j: Journey, runId: string): Promise<Record<string, string>[]> {
  const res = await j.t.app.inject({
    method: 'GET',
    url: `/api/runs/${runId}/records.csv`,
    headers: { cookie: j.api.cookie },
  });
  if (res.statusCode !== 200) throw new Error(`lineage export failed: ${res.statusCode} ${res.body}`);
  const lines = res.body.split('\r\n').filter((l) => l.length > 0);
  // The export carries a byte-order mark so Excel reads it as UTF-8, and quotes its cells — so the
  // header is read with the same reader as the rows rather than split on commas.
  const header = splitCsvLine(lines[0]!.replace(/^\uFEFF/, ''));
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

/** Enough CSV reading for the export's own quoting, which is what produced it. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

/** The evidence package, and what the product's own verifier makes of it. */
export async function evidence(j: Journey, runId: string) {
  const zip = await j.t.app.inject({
    method: 'GET',
    url: `/api/runs/${runId}/evidence.zip`,
    headers: { cookie: j.api.cookie },
  });
  if (zip.statusCode !== 200) throw new Error(`evidence export failed: ${zip.statusCode}`);
  const bytes = Buffer.from(zip.rawPayload);
  const verified = await j.api.post<{
    verdict: string;
    problems: string[];
    manifest: Record<string, unknown> | null;
  }>('/api/evidence/verify', { contentBase64: bytes.toString('base64') });
  return { bytes, ...verified };
}

/** How many distinct values of a key the target holds, and whether any repeats. */
export function keyCensus(
  rows: { data: Record<string, unknown> }[],
  column: string,
): { total: number; distinct: number; repeated: string[] } {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = String(row.data[column] ?? '');
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return {
    total: rows.length,
    distinct: counts.size,
    repeated: [...counts.entries()].filter(([, n]) => n > 1).map(([v]) => v),
  };
}
