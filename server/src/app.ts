import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '../../shared/domain';
import { SESSION_COOKIE, type ResolvedSession } from './auth/auth-service';
import type { AppConfig } from './config';
import { timingSafeEqualStr } from './lib/crypto';
import { can, normaliseRole, refusalFor, type Permission } from '../../shared/authorization';
import { AppError } from './lib/errors';
import { scrubSecrets } from './logger';
import { registerRoutes } from './routes';
import type { RequestContext } from './services/context';
import type { Services } from './services/container';

declare module 'fastify' {
  interface FastifyRequest {
    session: ResolvedSession | null;
    ctx: RequestContext;
  }
}

/**
 * Routes that answer without a session, as `METHOD path`.
 *
 * Method-qualified, not path-qualified. `/api/access-requests` takes a public POST from the landing
 * page and an operator-only GET that lists everyone who has submitted one; exempting the path would
 * have made that listing readable by anybody at all.
 */
const PUBLIC_ROUTES = new Set([
  'GET /api/health',
  'GET /api/auth/config',
  'GET /api/auth/login',
  'GET /api/auth/callback',
  'POST /api/auth/demo-login',
  'GET /api/auth/session',
  // The public sign-up path. The one route an unauthenticated stranger may write to, which is why it
  // is rate-limited hard, length-bounded in every field and tells the caller nothing back.
  'POST /api/access-requests',
]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Mutating routes that need something other than the ordinary "may change this workspace".
 *
 * Matched on the route's registered pattern, so `/api/runs/:id/cancel` is one entry rather than one
 * per run. Anything not listed falls through to `workspace:mutate`, which is the safe default: a
 * route added tomorrow is closed to the read-only roles without anybody editing this table.
 */
const MUTATION_PERMISSIONS: [RegExp, Permission][] = [
  // The one change a validator exists to make.
  [/^\/api\/validations$/, 'validation:run'],
  // Starting, stopping and resuming a migration. An operator may; a validator may not.
  [/^\/api\/plans\/[^/]+\/execute$/, 'migration:control'],
  [/^\/api\/runs\/[^/]+\/(cancel|pause|resume|retry|rerun)$/, 'migration:control'],
  // Accepting a readiness blocker authorises a migration to run that otherwise would not, which is
  // the same authority as starting one — and not a validator's.
  [/^\/api\/plans\/[^/]+\/readiness\/override$/, 'migration:control'],
  // Destroys a stored credential and the configuration other people's plans depend on.
  [/^\/api\/connections\/[^/]+$/, 'connections:delete'],
  // Keeps writing when nobody is watching.
  [/^\/api\/schedules/, 'schedules:write'],
  // Archives every project in the workspace and restores the simulated data.
  [/^\/api\/demo\/reset$/, 'workspace:reset'],
  [/^\/api\/members/, 'members:manage'],
];

function permissionForRoute(method: string, url: string): Permission {
  const path = url.split('?')[0] ?? url;
  for (const [pattern, permission] of MUTATION_PERMISSIONS) {
    // A connection is only destroyed by DELETE; editing one is an ordinary change.
    if (permission === 'connections:delete' && method !== 'DELETE') continue;
    if (pattern.test(path)) return permission;
  }
  return 'workspace:mutate';
}

/** The action named in a refusal, so the message says what was attempted. */
function describePermission(permission: Permission): string {
  switch (permission) {
    case 'validation:run':
      return 'Running a validation';
    case 'migration:control':
      return 'Starting or controlling a migration';
    case 'connections:delete':
      return 'Deleting a connection';
    case 'schedules:write':
      return 'Changing a schedule';
    case 'workspace:reset':
      return 'Resetting the workspace';
    case 'members:manage':
      return 'Changing who is in this workspace';
    default:
      return 'Changing anything in this workspace';
  }
}

export async function buildApp(services: Services, opts: { logger: Logger; webDist?: string }) {
  const config: AppConfig = services.config;
  const app = Fastify({
    loggerInstance: opts.logger as unknown as FastifyBaseLogger,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(incoming)
        ? incoming
        : crypto.randomUUID();
    },
    trustProxy: config.NODE_ENV === 'production',
    bodyLimit: 1_000_000,
  });

  app.decorateRequest('session', null);
  app.decorateRequest('ctx', null as unknown as RequestContext);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", 'https://login.microsoftonline.com'],
        upgradeInsecureRequests: config.COOKIE_SECURE ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 900,
    timeWindow: '1 minute',
    allowList: config.NODE_ENV === 'test' ? () => true : undefined,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  const allowedOrigins = new Set([new URL(config.APP_BASE_URL).origin]);
  if (config.NODE_ENV !== 'production') {
    allowedOrigins.add('http://localhost:5173');
    allowedOrigins.add('http://127.0.0.1:5173');
    allowedOrigins.add(`http://localhost:${config.PORT}`);
    allowedOrigins.add(`http://127.0.0.1:${config.PORT}`);
  }

  /**
   * Authentication, tenant context and CSRF protection for the API.
   *
   * `onRequest`, not `preHandler`. Fastify parses the body between them, so an unauthenticated request
   * to an upload route was fully received and JSON-parsed — up to that route's 48 MB limit — before the
   * 401 was raised. That is a large memory and CPU sink available with no credentials at all. Cookies
   * and headers are both available this early, so nothing is lost by refusing sooner.
   */
  app.addHook('onRequest', async (req: FastifyRequest) => {
    const url = req.routeOptions.url ?? req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin))
        throw new AppError(403, 'ORIGIN_REJECTED', 'Cross-origin request rejected');
    }
    req.session = await services.auth.resolveSession(req.cookies[SESSION_COOKIE]);
    // HEAD is served by the GET handler, so it inherits the GET exemption rather than 401ing.
    if (PUBLIC_ROUTES.has(`${req.method === 'HEAD' ? 'GET' : req.method} ${url}`)) return;
    if (!req.session) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !timingSafeEqualStr(header, req.session.csrfToken)) {
        throw new AppError(403, 'CSRF_REJECTED', 'Missing or invalid CSRF token');
      }
    }
    const u = req.session.user;
    req.ctx = {
      userId: u.id,
      organizationId: u.organization.id,
      // Roles stored before the four-role model existed are read here, once, rather than at
      // every site that asks what somebody may do.
      role: normaliseRole(u.role),
      isDemoOrg: u.organization.isDemo,
      displayName: u.displayName,
      requestId: req.id,
      platformOperator: u.platformOperator,
    };

    /*
      Authorization, before any handler runs.

      Enforced here rather than route by route because a model made of a hundred remembered checks
      is not a model: the one route somebody forgets is the hole, and nothing about the code says
      which route that is. Every mutating request must clear `workspace:mutate`, so a new route is
      closed to a validator and an auditor the moment it exists, without anybody remembering it.

      Routes that need something *other* than the default say so in MUTATION_PERMISSIONS below —
      either because they are more dangerous than an ordinary change, or because they are the one
      kind of change a validator is for.
    */
    if (!SAFE_METHODS.has(req.method)) {
      const permission = permissionForRoute(req.method, req.routeOptions?.url ?? req.url);
      if (!can(req.ctx.role, permission)) {
        throw new AppError(403, 'FORBIDDEN', refusalFor(req.ctx.role, describePermission(permission)));
      }
    }
  });

  app.setErrorHandler((err: unknown, req, reply: FastifyReply) => {
    let status = 500;
    let body: ApiErrorBody;
    if (err instanceof AppError) {
      status = err.statusCode;
      // Scrubbed like every other message: an integration error is wrapped in an AppError, and a
      // connection string in its text is exactly the shape that would otherwise reach the client.
      body = {
        error: {
          code: err.code,
          message: scrubSecrets(err.message),
          requestId: req.id,
          details: err.details,
        },
      };
    } else if (err instanceof ZodError) {
      status = 400;
      body = {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          requestId: req.id,
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      };
    } else if (
      (err as { statusCode?: number }).statusCode &&
      (err as { statusCode: number }).statusCode < 500
    ) {
      status = (err as { statusCode: number }).statusCode;
      body = {
        error: {
          code: (err as { code?: string }).code ?? 'BAD_REQUEST',
          message: scrubSecrets((err as Error).message),
          requestId: req.id,
        },
      };
    } else {
      body = {
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId: req.id },
      };
    }
    if (status >= 500) req.log.error({ err }, 'Request failed');
    else if (status !== 401)
      req.log.warn({ code: body.error.code, status, message: body.error.message }, 'Request rejected');
    void reply.status(status).send(body);
  });

  await registerRoutes(app, services);

  const webDist = opts.webDist ?? path.resolve('dist/web');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: true, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      // Unknown API routes and missing static assets are real 404s; everything else is the SPA.
      if (
        req.url.startsWith('/api/') ||
        (req.method !== 'GET' && req.method !== 'HEAD') ||
        /\.[a-z0-9]+(\?|$)/i.test(req.url)
      ) {
        void reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } });
        return;
      }
      void reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      void reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } });
    });
  }

  return app;
}
