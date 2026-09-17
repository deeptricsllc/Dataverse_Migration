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

const PUBLIC_ROUTES = new Set([
  '/api/health',
  '/api/auth/config',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/demo-login',
  '/api/auth/session',
]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

  // Authentication, tenant context and CSRF protection for the API.
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const url = req.routeOptions.url ?? req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin))
        throw new AppError(403, 'ORIGIN_REJECTED', 'Cross-origin request rejected');
    }
    req.session = await services.auth.resolveSession(req.cookies[SESSION_COOKIE]);
    if (PUBLIC_ROUTES.has(url)) return;
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
      role: u.role,
      isDemoOrg: u.organization.isDemo,
      displayName: u.displayName,
      requestId: req.id,
    };
  });

  app.setErrorHandler((err: unknown, req, reply: FastifyReply) => {
    let status = 500;
    let body: ApiErrorBody;
    if (err instanceof AppError) {
      status = err.statusCode;
      body = { error: { code: err.code, message: err.message, requestId: req.id, details: err.details } };
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
