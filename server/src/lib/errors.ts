export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);
export const forbidden = (message = 'Forbidden') => new AppError(403, 'FORBIDDEN', message);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
