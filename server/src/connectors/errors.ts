import { AppError } from '../lib/errors';

/**
 * Raised when a service asks a connector for something its provider genuinely cannot do.
 * Callers are expected to check `connector.capabilities` first; this is the backstop.
 */
export function unsupportedOperation(operation: string, provider: string): AppError {
  return new AppError(400, 'UNSUPPORTED_OPERATION', `${provider} connections do not support ${operation}.`);
}
