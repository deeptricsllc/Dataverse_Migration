import { loadConfig } from '../config';
import { createDatabase } from './client';

const config = loadConfig();
const database = await createDatabase({
  databaseUrl: config.DATABASE_URL,
  pgliteDataDir: config.PGLITE_DATA_DIR,
});
await database.migrate(config.MIGRATIONS_DIR);
console.log(`Migrations applied (${database.kind}).`);
await database.close();
