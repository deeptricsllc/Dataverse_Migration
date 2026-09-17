import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/src/app';
import { loadConfig } from '../server/src/config';
import { createDatabase, type Database } from '../server/src/db/client';
import { createLogger } from '../server/src/logger';
import { createServices, type Services } from '../server/src/services/container';

export interface TestApp {
  app: FastifyInstance;
  services: Services;
  database: Database;
  close: () => Promise<void>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    DATABASE_URL: '',
    PGLITE_DATA_DIR: 'memory://',
    LOG_LEVEL: 'silent',
    ENTRA_CLIENT_ID: '',
    ENTRA_CLIENT_SECRET: '',
    ...overrides,
  });
  const logger = createLogger(process.env.TEST_LOG_LEVEL ?? 'silent');
  // TEST_DATABASE_URL runs the suite against a real (empty) PostgreSQL database instead of PGlite.
  const database = await createDatabase({
    databaseUrl: process.env.TEST_DATABASE_URL || undefined,
    pgliteDataDir: 'memory://',
  });
  await database.migrate(config.MIGRATIONS_DIR);
  const services = createServices(config, database.db, logger);
  const app = await buildApp(services, { logger, webDist: '__none__' });
  await app.ready();
  return {
    app,
    services,
    database,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

/** Minimal API client that carries the session cookie and CSRF token like the browser does. */
export class ApiClient {
  cookie = '';
  csrf = '';

  constructor(private readonly app: FastifyInstance) {}

  async demoLogin() {
    const res = await this.app.inject({ method: 'POST', url: '/api/auth/demo-login' });
    if (res.statusCode !== 200) throw new Error(`demo login failed: ${res.body}`);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
    this.cookie = raw.split(';')[0];
    this.csrf = res.json().csrfToken;
    return res.json();
  }

  async request<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    expectStatus = 200,
  ): Promise<T> {
    const res = await this.app.inject({
      method,
      url,
      payload: body as never,
      headers: { cookie: this.cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': this.csrf }) },
    });
    if (res.statusCode !== expectStatus) {
      throw new Error(`${method} ${url} -> ${res.statusCode} (expected ${expectStatus}): ${res.body}`);
    }
    return res.body ? (res.json() as T) : (undefined as T);
  }

  get = <T = any>(url: string, expect = 200) => this.request<T>('GET', url, undefined, expect);
  post = <T = any>(url: string, body?: unknown, expect = 200) =>
    this.request<T>('POST', url, body ?? {}, expect);
  put = <T = any>(url: string, body?: unknown, expect = 200) => this.request<T>('PUT', url, body, expect);
  patch = <T = any>(url: string, body?: unknown, expect = 200) => this.request<T>('PATCH', url, body, expect);
}
