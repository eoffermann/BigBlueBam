// Shared service error classes for bay-api. Mirrors the NotFound/Conflict
// pattern used by bin-api's asset.service.ts; centralized here because Bay has
// several services that all map onto the same error envelope.

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
