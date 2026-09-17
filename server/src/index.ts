import { buildApp } from './app';
import { loadConfig } from './config';
import { createDatabase } from './db/client';
import { createLogger } from './logger';
import { createServices } from './services/container';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.LOG_PRETTY);

const database = await createDatabase({ databaseUrl: config.DATABASE_URL, pgliteDataDir: config.PGLITE_DATA_DIR });
await database.migrate(config.MIGRATIONS_DIR);
logger.info({ database: database.kind }, 'Database ready (migrations applied)');

const services = createServices(config, database.db, logger);
const app = await buildApp(services, { logger });

const worker = config.RUN_WORKER ? services.createWorker() : null;
if (!config.RUN_WORKER && database.kind === 'pglite') {
  logger.warn('RUN_WORKER=false with embedded PGlite: jobs will not run (PGlite cannot be shared with a separate worker process).');
}

await app.listen({ host: config.HOST, port: config.PORT });
logger.info(
  { url: config.APP_BASE_URL, demoMode: config.DEMO_MODE, microsoftEnabled: config.microsoftEnabled },
  'Dataverse Migration Platform started',
);
if (worker) await worker.start();

const purge = setInterval(() => void services.auth.purgeExpired().catch(() => undefined), 60 * 60_000);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  clearInterval(purge);
  await app.close();
  await worker?.stop();
  await database.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
