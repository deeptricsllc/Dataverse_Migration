/**
 * Standalone worker process for PostgreSQL deployments (RUN_WORKER=false on web instances).
 * Jobs are claimed with SKIP LOCKED, so several workers can run side by side.
 */
import { loadConfig } from './config';
import { createDatabase } from './db/client';
import { createLogger } from './logger';
import { createServices } from './services/container';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.LOG_PRETTY).child({ process: 'worker' });

if (!config.DATABASE_URL) {
  logger.error(
    'The standalone worker requires DATABASE_URL (PostgreSQL). With embedded PGlite the web process runs jobs itself.',
  );
  process.exit(1);
}

const database = await createDatabase({
  databaseUrl: config.DATABASE_URL,
  pgliteDataDir: config.PGLITE_DATA_DIR,
});
await database.migrate(config.MIGRATIONS_DIR);
const services = createServices(config, database.db, logger);
const worker = services.createWorker();
await worker.start();

async function shutdown(signal: string) {
  logger.info({ signal }, 'Worker shutting down; waiting for in-flight jobs');
  await worker.stop();
  await database.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
