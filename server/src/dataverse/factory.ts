import { and, count, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { MicrosoftIdentityService } from '../auth/microsoft-identity';
import { POWER_PLATFORM_SCOPE } from '../auth/microsoft-identity';
import type { AppConfig } from '../config';
import type { SqlConnectionConfig } from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { demoRecords, type environments } from '../db/schema';
import { AppError } from '../lib/errors';
import { DemoConnection } from './demo/demo-connection';
import { DEMO_DATA_VERSION, DEMO_ENVIRONMENTS, datasetFor, type DemoEnvKey } from './demo/fixtures';

/** Pseudo-table holding the fixtures version that seeded an environment. */
const SEED_MARKER = '__seed_version';
import { GlobalDiscoveryProvider, type EnvironmentDiscoveryProvider } from './discovery';
import type { DiscoveredEnvironment } from './types';
import { WebApiConnection } from './web-api-connection';
import type { MigrationConnector } from '../connectors/types';
import { DemoSqlConnection } from '../connectors/sql/demo-sql-connector';
import { SqlConnector } from '../connectors/sql/sql-connector';
import {
  DEMO_SQL_ENVIRONMENT,
  DEMO_SQL_ENV_KEY,
  DEMO_SQL_URL,
  demoSqlData,
  demoSqlTables,
} from '../connectors/sql/demo-fixtures';
import { SecretBox } from '../lib/crypto';
import { connectionSecrets } from '../db/schema';

type EnvironmentRow = typeof environments.$inferSelect;

/**
 * Creates a connector for any connection — Dataverse, SQL Server, Azure SQL or their simulated
 * demo equivalents — plus the Dataverse discovery providers. Every service depends on the
 * connector contract, so this is the only place that knows which implementation to build.
 */
export class ConnectionFactory {
  private readonly secrets: SecretBox;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDb,
    private readonly logger: Logger,
    private readonly identity: MicrosoftIdentityService,
  ) {
    this.secrets = new SecretBox(config.sessionSecret, 'connection-credentials');
  }

  /** Encrypts a database password for storage. The plaintext never leaves this process. */
  encryptSecret(plaintext: string): string {
    return this.secrets.encrypt(plaintext);
  }

  private async loadSecret(environmentId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ ciphertext: connectionSecrets.ciphertext })
      .from(connectionSecrets)
      .where(eq(connectionSecrets.environmentId, environmentId));
    if (!row) return null;
    try {
      return this.secrets.decrypt(row.ciphertext);
    } catch {
      throw new AppError(
        500,
        'SECRET_UNREADABLE',
        'The stored credential could not be decrypted. Re-enter the password for this connection.',
      );
    }
  }

  /**
   * SQL connectors need their (decrypted) password, which requires a database read, so building
   * one is asynchronous. Dataverse connectors are returned synchronously by
   * {@link forEnvironment}; this is the general entry point every caller should prefer.
   */
  async connectorFor(
    env: EnvironmentRow,
    userId: string,
    logContext: Record<string, unknown> = {},
  ): Promise<MigrationConnector> {
    if (env.connectionType === 'DATAVERSE') return this.forEnvironment(env, userId, logContext);
    const logger = this.logger.child({ environmentId: env.id, ...logContext });
    if (env.provider === 'demosql') {
      if (!this.config.DEMO_MODE) throw new AppError(400, 'DEMO_DISABLED', 'Demo connections are disabled');
      return new DemoSqlConnection(
        env.uniqueName ?? DEMO_SQL_ENV_KEY,
        this.db,
        logger,
        this.config.NODE_ENV === 'test' ? 0 : this.config.DEMO_LATENCY_MS,
      );
    }
    if (!env.sqlConfig) {
      throw new AppError(400, 'CONNECTION_INCOMPLETE', 'This SQL connection has no configuration');
    }
    return new SqlConnector(
      {
        config: env.sqlConfig,
        password: await this.loadSecret(env.id),
        logger,
        // The same safety switch that protects a real Dataverse tenant protects a real database.
        readOnly: this.config.REAL_TENANT_READ_ONLY,
      },
      env.connectionType === 'AZURE_SQL' ? 'azuresql' : 'sqlserver',
    );
  }

  forEnvironment(
    env: EnvironmentRow,
    userId: string,
    logContext: Record<string, unknown> = {},
  ): MigrationConnector {
    const logger = this.logger.child({ environmentId: env.id, ...logContext });
    if (env.connectionType !== 'DATAVERSE') {
      throw new AppError(
        500,
        'CONNECTOR_ASYNC_REQUIRED',
        `A ${env.connectionType} connection must be created with connectorFor().`,
      );
    }
    if (env.provider === 'demo') {
      if (!this.config.DEMO_MODE) throw new AppError(400, 'DEMO_DISABLED', 'Demo environments are disabled');
      const def = DEMO_ENVIRONMENTS.find((d) => d.key === env.uniqueName);
      if (!def) throw new AppError(404, 'NOT_FOUND', 'Demo environment not found');
      // Demo environments are simulated and hold no tenant data, so REAL_TENANT_READ_ONLY
      // (which protects real Dataverse) does not disable them.
      return new DemoConnection(
        def,
        this.db,
        logger,
        this.config.NODE_ENV === 'test' ? 0 : this.config.DEMO_LATENCY_MS,
      );
    }
    return new WebApiConnection({
      // The Global Discovery Service returns both Url (application) and ApiUrl (web API).
      // https://learn.microsoft.com/power-apps/developer/data-platform/discovery-service
      url: env.apiUrl || env.url,
      apiVersion: this.config.DATAVERSE_API_VERSION,
      logger,
      readOnly: this.config.REAL_TENANT_READ_ONLY,
      getAccessToken: () => this.identity.getResourceToken(userId, env.apiUrl || env.url),
    });
  }

  /** Builds a connector from an unsaved SQL configuration, for "test connection" before saving. */
  sqlConnectorFor(
    connectionType: 'SQL_SERVER' | 'AZURE_SQL',
    config: SqlConnectionConfig,
    password: string | null,
  ): SqlConnector {
    return new SqlConnector(
      { config, password, logger: this.logger, readOnly: this.config.REAL_TENANT_READ_ONLY },
      connectionType === 'AZURE_SQL' ? 'azuresql' : 'sqlserver',
    );
  }

  /**
   * The simulated legacy SQL Server offered to demo organizations, so the SQL to Dataverse
   * journey can be walked end to end without a database server. Null when demo mode is off.
   */
  demoSqlDefinition() {
    if (!this.config.DEMO_MODE) return null;
    return {
      key: DEMO_SQL_ENV_KEY,
      displayName: DEMO_SQL_ENVIRONMENT.displayName,
      url: DEMO_SQL_URL,
      version: DEMO_SQL_ENVIRONMENT.version,
      config: {
        host: DEMO_SQL_ENVIRONMENT.host,
        port: DEMO_SQL_ENVIRONMENT.port,
        database: DEMO_SQL_ENVIRONMENT.database,
        authType: 'SQL_LOGIN',
        username: 'iic_migration',
        encrypt: true,
        trustServerCertificate: false,
        transport: 'DIRECT',
        schemas: [],
      } satisfies SqlConnectionConfig,
    };
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
      getDiscoveryToken: () => this.identity.getResourceToken(userId, this.config.DATAVERSE_DISCOVERY_URL),
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
  await seedDemoSqlData(db, opts);
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

/**
 * Seeds the simulated legacy SQL Server. Rows are stored in the same table as the simulated
 * Dataverse data, keyed by the SQL table's `schema.Table` name, and re-seeded when the fixtures
 * version changes so an existing deployment picks up new demo data.
 */
export async function seedDemoSqlData(
  db: AppDb,
  opts: { logger?: { info: (o: object, m: string) => void } } = {},
) {
  const [existing] = await db
    .select({ n: count() })
    .from(demoRecords)
    .where(eq(demoRecords.environmentKey, DEMO_SQL_ENV_KEY));
  if (Number(existing?.n ?? 0) > 0) {
    const [marker] = await db
      .select({ id: demoRecords.recordId })
      .from(demoRecords)
      .where(
        and(
          eq(demoRecords.environmentKey, DEMO_SQL_ENV_KEY),
          eq(demoRecords.logicalName, SEED_MARKER),
          eq(demoRecords.recordId, DEMO_DATA_VERSION),
        ),
      );
    if (marker) return;
    opts.logger?.info({ version: DEMO_DATA_VERSION }, 'Re-seeding demo SQL Server');
    await db.delete(demoRecords).where(eq(demoRecords.environmentKey, DEMO_SQL_ENV_KEY));
  }
  const tables = new Map(demoSqlTables().map((t) => [t.logicalName, t]));
  const data = demoSqlData();
  for (const [logicalName, rows] of Object.entries(data)) {
    const meta = tables.get(logicalName);
    if (!meta) continue;
    const values = rows.map((r) => ({
      environmentKey: DEMO_SQL_ENV_KEY,
      logicalName,
      recordId: String(r[meta.primaryIdAttribute]).toLowerCase(),
      data: r as Record<string, never>,
    }));
    for (let i = 0; i < values.length; i += 200) {
      await db
        .insert(demoRecords)
        .values(values.slice(i, i + 200))
        .onConflictDoNothing();
    }
  }
  await db
    .insert(demoRecords)
    .values({
      environmentKey: DEMO_SQL_ENV_KEY,
      logicalName: SEED_MARKER,
      recordId: DEMO_DATA_VERSION,
      data: {},
    })
    .onConflictDoNothing();
}
