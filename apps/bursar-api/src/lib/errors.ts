// Typed service-layer errors. Routes map these onto the canonical error envelope
// { error: { code, message, details, request_id } } via lib/http.ts mapServiceError.

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
  ) {
    super(message);
    this.name = 'ValidationFailure';
  }
}

/** A uniqueness / constraint conflict, e.g. a duplicate (org, lower(display_name)) vendor. */
export class ConflictError extends Error {
  constructor(
    message = 'Conflict',
    public readonly current?: unknown,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * A Bin asset the caller may not read, resolved through §5.8. Deliberately surfaced as 404,
 * never 403: existence of another tenant's or a private asset must not be confirmable.
 */
export class AssetAccessError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'AssetAccessError';
  }
}
