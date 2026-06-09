/**
 * Domain-error classes used by blueprint-api services. The route layer
 * maps these into structured 4xx responses; nothing here ever crosses
 * over the HTTP boundary directly.
 */

export class NotFoundError extends Error {
  public readonly code = 'NOT_FOUND' as const;
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  public readonly code = 'FORBIDDEN' as const;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends Error {
  public readonly code = 'VALIDATION_ERROR' as const;
  public readonly details: Array<{ field: string; issue: string }>;
  constructor(message: string, details: Array<{ field: string; issue: string }> = []) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export class ConflictError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ConflictError';
  }
}
