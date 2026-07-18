// Typed service-layer errors. Routes map these onto the canonical error envelope
// { error: { code, message, details, request_id } }.

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

// A merge/reject lost the compare-and-swap (another actor already decided the
// candidate, or a profile was already merged away). The loser no-ops (spec 2.2).
export class MergeConflictError extends Error {
  constructor(message = 'Candidate already decided or profile already merged') {
    super(message);
    this.name = 'MergeConflictError';
  }
}

// PATCH /settings tried to enable a source_type with no verified visibility branch
// (spec 5.5). Carries the offending type for a precise 4xx.
export class SourceTypeNotSupportedError extends Error {
  constructor(public readonly sourceType: string) {
    super(`Source type '${sourceType}' has no verified visibility branch and cannot be enabled`);
    this.name = 'SourceTypeNotSupportedError';
  }
}

// Per-asker resolve rate limit exceeded (spec 5.1).
export class RateLimitError extends Error {
  constructor(message = 'Resolve rate limit exceeded') {
    super(message);
    this.name = 'RateLimitError';
  }
}

// A resolve was denied because the caller cannot see the input source record
// (spec 5.1: deny returns not_found, never a golden id).
export class AccessDeniedError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}
