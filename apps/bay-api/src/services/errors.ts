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
