// Shared service error classes for blip-api. Services throw these; route files
// map them onto the standard { error: { code, message, details, request_id } }
// envelope (see lib/send-error.ts).

export class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** A share link that existed but is no longer usable (expired or revoked). */
export class GoneError extends Error {
  constructor(message = 'This link is no longer available') {
    super(message);
    this.name = 'GoneError';
  }
}

/** The action is understood but not permitted (e.g. comments disabled). */
export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** A malformed request that passed schema validation but is semantically bad. */
export class ValidationError extends Error {
  constructor(message = 'Invalid request') {
    super(message);
    this.name = 'ValidationError';
  }
}
