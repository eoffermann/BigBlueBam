// Typed service-layer errors. Routes map these onto the canonical error envelope
// { error: { code, message, details, request_id } } via lib/http.ts mapServiceError.
// Messages are plain language: they reach the Setup wizard as-is.

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationFailure extends Error {
  constructor(
    message: string,
    public readonly code = 'VALIDATION_ERROR',
    public readonly details: Array<{ field: string; issue: string }> = [],
  ) {
    super(message);
    this.name = 'ValidationFailure';
  }
}

export class ConflictError extends Error {
  constructor(
    message = 'Conflict',
    public readonly code = 'CONFLICT',
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}
