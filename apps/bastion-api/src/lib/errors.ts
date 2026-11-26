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

/**
 * The single row an INSERT/UPDATE ... RETURNING (or a lookup that must hit) produced. Throws an
 * internal error rather than letting `undefined` flow on, which a non-null assertion would.
 */
export function one<T>(rows: readonly T[], what = 'row'): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected one ${what}, got none`);
  return row;
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

/** A service-layer rule on top of the permission (e.g. owner-only acts, spec 5.5). Maps to 403. */
export class ForbiddenError extends Error {
  constructor(
    message = 'You cannot do this.',
    public readonly code = 'FORBIDDEN',
  ) {
    super(message);
    this.name = 'ForbiddenError';
  }
}
