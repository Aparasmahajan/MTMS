/**
 * Errors carry the code the HTTP boundary turns into a status, and a message written
 * for the person who hit it — never a stack trace and never a hint about another
 * tenant's data.
 */

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal';

export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ServiceError('bad_request', message, details);
export const unauthenticated = (message = 'Sign in to continue') =>
  new ServiceError('unauthenticated', message);
export const forbidden = (message: string, details?: unknown) =>
  new ServiceError('forbidden', message, details);
export const notFound = (message = 'Not found') => new ServiceError('not_found', message);
export const conflict = (message: string, details?: unknown) =>
  new ServiceError('conflict', message, details);
export const validationFailed = (message: string, details?: unknown) =>
  new ServiceError('validation_failed', message, details);
