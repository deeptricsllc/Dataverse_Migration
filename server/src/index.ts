import { PRODUCT_NAME } from '../../shared/product';
import { buildApp } from './app';
import { describeAuthConfiguration, formatAuthConfiguration } from './auth/auth-configuration';
import { loadConfig } from './config';
import { createDatabase, migrateWhenReachable } from './db/client';
import { createLogger } from './logger';
import { createServices } from './services/container';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.LOG_PRETTY);

/**
 * Say what sign-in will do, before anybody tries it.
 *
 * Both ways the QA deployment's sign-in was broken — an authority that resolved the user's own
 * directory rather than the application's, and GATED admission with an empty allow list — were
 * invisible in the logs and obvious in the configuration. A deployment that nobody can sign in to
 * now says so on its first line rather than on somebody's first attempt.
 */
{
  const auth = describeAuthConfiguration(config);
  const [summary, ...issues] = formatAuthConfiguration(auth);
  logger.info(summary);
  for (const line of issues) {
    if (line.startsWith('[BLOCKS_SIGN_IN]')) logger.error(line);
    else if (line.startsWith('[WARNING]')) logger.warn(line);
    else logger.info(line);
  }
  if (!auth.anySignInPossible) {
    logger.error('Nobody can sign in to this deployment with its current configuration.');
  }
}

const database = await createDatabase({
  databaseUrl: config.DATABASE_URL,
  pgliteDataDir: config.PGLITE_DATA_DIR,
  onPoolError: (error) => logger.error({ err: error }, 'Idle database connection failed'),
});
await migrateWhenReachable(database, config.MIGRATIONS_DIR, {
  onWait: (info) => logger.warn(info, 'Database not reachable yet, waiting'),
});
logger.info({ database: database.kind }, 'Database ready (migrations applied)');

const services = createServices(config, database.db, logger);
const app = await buildApp(services, { logger });

const worker = config.RUN_WORKER ? services.createWorker() : null;
const scheduler = config.RUN_WORKER ? services.createScheduler() : null;
if (!config.RUN_WORKER && database.kind === 'pglite') {
  logger.warn(
    'RUN_WORKER=false with embedded PGlite: jobs will not run (PGlite cannot be shared with a separate worker process).',
  );
}

await app.listen({ host: config.HOST, port: config.PORT });
logger.info(
  { url: config.APP_BASE_URL, demoMode: config.DEMO_MODE, microsoftEnabled: config.microsoftEnabled },
  `${PRODUCT_NAME} started`,
);
if (worker) await worker.start();
scheduler?.start();

const purge = setInterval(() => void services.auth.purgeExpired().catch(() => undefined), 60 * 60_000);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  clearInterval(purge);
  await app.close();
  scheduler?.stop();
  await worker?.stop();
  await database.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
