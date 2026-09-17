import { and, count, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { MicrosoftIdentityService } from '../auth/microsoft-identity';
import { POWER_PLATFORM_SCOPE, dataverseScope, discoveryScope } from '../auth/microsoft-identity';
import type { AppConfig } from '../config';
import type { AppDb } from '../db/client';
import { demoRecords, type environments } from '../db/schema';
import { AppError } from '../lib/errors';
import { DemoConnection } from './demo/demo-connection';
import { DEMO_DATA_VERSION, DEMO_ENVIRONMENTS, datasetFor, type DemoEnvKey } from './demo/fixtures';

/** Pseudo-table holding the fixtures version that seeded an environment. */
const SEED_MARKER = '__seed_version';
import { GlobalDiscoveryProvider, type EnvironmentDiscoveryProvider } from './discovery';
import type { DataverseConnection, DiscoveredEnvironment } from './types';
import { WebApiConnection } from './web-api-connection';

type EnvironmentRow = typeof environments.$inferSelect;

/** Creates Dataverse connections and discovery providers for a user, real or demo. */
export class ConnectionFactory {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDb,
    private readonly logger: Logger,
    private readonly identity: MicrosoftIdentityService,
  ) {}

  forEnvironment(
    env: EnvironmentRow,
    userId: string,
    logContext: Record<string, unknown> = {},
  ): DataverseConnection {
    const logger = this.logger.child({ environmentId: env.id, ...logContext });
    if (env.provider === 'demo') {
      if (!this.config.DEMO_MODE) throw new AppError(400, 'DEMO_DISABLED', 'Demo environments are disabled');
      const def = DEMO_ENVIRONMENTS.find((d) => d.key === env.uniqueName);
      if (!def) throw new AppError(404, 'NOT_FOUND', 'Demo environment not found');
      return new DemoConnection(
        def,
        this.db,
        logger,
        this.config.NODE_ENV === 'test' ? 0 : this.config.DEMO_LATENCY_MS,
      );
    }
    return new WebApiConnection({
      url: env.url,
      apiVersion: this.config.DATAVERSE_API_VERSION,
      logger,
      getAccessToken: () => this.identity.getAccessToken(userId, [dataverseScope(env.url)]),
    });
  }

  discoveryProvider(isDemoOrg: boolean, userId: string): EnvironmentDiscoveryProvider {
    if (isDemoOrg) {
      return {
        discover: async (): Promise<DiscoveredEnvironment[]> =>
          DEMO_ENVIRONMENTS.map((d) => ({
            provider: 'demo',
            displayName: d.displayName,
            url: d.url,
            apiUrl: `${d.url}/api/data/v9.2`,
            organizationId: null,
            environmentId: null,
            uniqueName: d.key,
            environmentType: d.environmentType,
            region: d.region,
            version: d.version,
            state: 'Enabled',
            dataverseAvailable: true,
          })),
      };
    }
    return new GlobalDiscoveryProvider({
      discoveryUrl: this.config.DATAVERSE_DISCOVERY_URL,
      logger: this.logger.child({ userId }),
      getDiscoveryToken: () =>
        this.identity.getAccessToken(userId, [discoveryScope(this.config.DATAVERSE_DISCOVERY_URL)]),
      getPowerPlatformToken: this.config.POWER_PLATFORM_ENRICHMENT
        ? () => this.identity.getAccessToken(userId, [POWER_PLATFORM_SCOPE])
        : undefined,
    });
  }
}

/**
 * Seeds simulated Dataverse data for demo environments. Idempotent: an environment is only
 * (re-)seeded when it is empty, when the fixtures version changed, or on an explicit reset.
 */
export async function seedDemoData(
  db: AppDb,
  opts: { reset?: boolean; logger?: { info: (o: object, m: string) => void } } = {},
) {
  if (opts.reset) await db.delete(demoRecords);
  for (const env of DEMO_ENVIRONMENTS) {
    const [existing] = await db
      .select({ n: count() })
      .from(demoRecords)
      .where(eq(demoRecords.environmentKey, env.key));
    if (Number(existing?.n ?? 0) > 0) {
      const [marker] = await db
        .select({ id: demoRecords.recordId })
        .from(demoRecords)
        .where(
          and(
            eq(demoRecords.environmentKey, env.key),
            eq(demoRecords.logicalName, SEED_MARKER),
            eq(demoRecords.recordId, DEMO_DATA_VERSION),
          ),
        );
      if (marker) continue;
      // Fixtures changed: replace this demo environment's data.
      opts.logger?.info({ environment: env.key, version: DEMO_DATA_VERSION }, 'Re-seeding demo environment');
      await db.delete(demoRecords).where(eq(demoRecords.environmentKey, env.key));
    }
    const dataset = datasetFor(env.key as DemoEnvKey);
    const rows = Object.entries(dataset).flatMap(([logicalName, records]) =>
      records.map((data) => ({
        environmentKey: env.key,
        logicalName,
        recordId: String(data[`${logicalName}id`]).toLowerCase(),
        data,
      })),
    );
    for (let i = 0; i < rows.length; i += 200) {
      await db
        .insert(demoRecords)
        .values(rows.slice(i, i + 200))
        .onConflictDoNothing();
    }
    await db
      .insert(demoRecords)
      .values({ environmentKey: env.key, logicalName: SEED_MARKER, recordId: DEMO_DATA_VERSION, data: {} })
      .onConflictDoNothing();
  }
}

export async function demoRecordCount(db: AppDb, envKey: string, table: string) {
  const [row] = await db
    .select({ n: count() })
    .from(demoRecords)
    .where(and(eq(demoRecords.environmentKey, envKey), eq(demoRecords.logicalName, table)));
  return Number(row?.n ?? 0);
}
