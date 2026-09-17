import pino, { type Logger } from 'pino';

/** Paths that must never reach log output. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.idToken',
  '*.id_token',
  '*.token',
  '*.clientSecret',
  '*.client_secret',
  '*.password',
  '*.secret',
  '*.codeVerifier',
  'authorization',
];

export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'dataverse-migration' },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}

/** Strips bearer tokens or JWT-looking strings from free text before it is logged or persisted. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]')
    .replace(/(client_secret|refresh_token|access_token|code)=([^&\s]+)/gi, '$1=[REDACTED]');
}
