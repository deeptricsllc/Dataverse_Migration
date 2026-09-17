import { scrubSecrets } from '../logger';

export type DataverseErrorCode =
  | 'READ_ONLY_MODE'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'THROTTLED'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DUPLICATE_RECORD'
  | 'VALIDATION'
  | 'REFERENCE_NOT_FOUND'
  | 'SERVER_ERROR'
  | 'UNKNOWN';

const RETRYABLE: ReadonlySet<DataverseErrorCode> = new Set(['NETWORK', 'TIMEOUT', 'THROTTLED']);

export class DataverseError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly code: DataverseErrorCode,
    message: string,
    public readonly status?: number,
    public readonly platformCode?: string,
    /** Seconds suggested by the Retry-After header. */
    public readonly retryAfterSeconds?: number,
    retryable?: boolean,
  ) {
    super(scrubSecrets(message).slice(0, 2000));
    this.name = 'DataverseError';
    this.retryable = retryable ?? RETRYABLE.has(code);
  }
}

const DUPLICATE_CODES = new Set(['0x80040237', '0x80060892', '0x80040333']);
const REFERENCE_CODES = new Set(['0x80040217']);
const PRIVILEGE_CODES = new Set(['0x80040220', '0x80042f09']);

/** Maps an HTTP response + Dataverse error payload to a structured error. */
export function classifyHttpError(status: number, body: unknown, retryAfter?: string | null): DataverseError {
  const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
  const platformCode = err?.code;
  const message = err?.message ?? `Dataverse request failed with HTTP ${status}`;
  const retryAfterSeconds = retryAfter ? Number(retryAfter) || undefined : undefined;
  if (status === 429)
    return new DataverseError('THROTTLED', message, status, platformCode, retryAfterSeconds);
  if (status === 401) return new DataverseError('AUTH_REQUIRED', message, status, platformCode);
  if (status === 403 || (platformCode && PRIVILEGE_CODES.has(platformCode))) {
    return new DataverseError('FORBIDDEN', message, status, platformCode);
  }
  if (platformCode && DUPLICATE_CODES.has(platformCode)) {
    return new DataverseError('DUPLICATE_RECORD', message, status, platformCode);
  }
  if (platformCode && REFERENCE_CODES.has(platformCode)) {
    return new DataverseError('REFERENCE_NOT_FOUND', message, status, platformCode);
  }
  if (status === 404) return new DataverseError('NOT_FOUND', message, status, platformCode);
  if (status === 409 || status === 412)
    return new DataverseError('DUPLICATE_RECORD', message, status, platformCode);
  if (status === 408) return new DataverseError('TIMEOUT', message, status, platformCode);
  if (status === 502 || status === 503 || status === 504) {
    return new DataverseError('SERVER_ERROR', message, status, platformCode, retryAfterSeconds, true);
  }
  if (status >= 500) return new DataverseError('SERVER_ERROR', message, status, platformCode);
  if (status >= 400) return new DataverseError('VALIDATION', message, status, platformCode);
  return new DataverseError('UNKNOWN', message, status, platformCode);
}

export function toDataverseError(err: unknown): DataverseError {
  if (err instanceof DataverseError) return err;
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError')
      return new DataverseError('TIMEOUT', err.message);
    const cause = (err as { cause?: { code?: string } }).cause;
    if (err instanceof TypeError || cause?.code) return new DataverseError('NETWORK', err.message);
    return new DataverseError('UNKNOWN', err.message, undefined, undefined, undefined, false);
  }
  return new DataverseError('UNKNOWN', String(err), undefined, undefined, undefined, false);
}
