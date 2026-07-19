// Typed service-layer errors. Routes map these onto the canonical error envelope
// { error: { code, message, details, request_id } } via lib/http.ts mapServiceError.

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * The caller is authenticated in the org but does not pass Burn's project predicate for the
 * chain (spec 2.4 point 6). Surfaced as 404 on reads so existence is never leaked, 403 on
 * writes.
 */
export class ProjectScopeError extends Error {
  constructor(message = 'Not a member of any project linked to this engagement') {
    super(message);
    this.name = 'ProjectScopeError';
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

/** A last-write-wins / CAS conflict. Carries the current state so the client can re-render. */
export class ConflictError extends Error {
  constructor(
    message = 'Conflict',
    public readonly current?: unknown,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** A rate/probe cap was hit (spec 2.4 point 3, point 10). Surfaced as 429. */
export class RateLimitedError extends Error {
  constructor(
    message: string,
    public readonly code = 'RATE_LIMITED',
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}
