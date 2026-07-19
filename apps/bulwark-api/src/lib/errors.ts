// Typed service-layer errors. Routes map these onto the canonical error envelope
// { error: { code, message, details, request_id } }.

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

// The caller is authenticated in the org but is not a member of the owning contract's
// project (and is not an org admin), so a project-scoped read/write is denied (spec 2.5
// SH1/SH3). Surfaced as 403 on writes, 404 on reads (never leak existence).
export class ProjectScopeError extends Error {
  constructor(message = 'Not a member of the owning project') {
    super(message);
    this.name = 'ProjectScopeError';
  }
}

// A validation failure the service layer detected (e.g. an implausible occurred_at, a
// recurrence with both until and expiry null, a non-allowlisted payload_path). Carries a
// short machine code for the envelope.
export class ValidationFailure extends Error {
  constructor(
    message: string,
    public readonly code = 'VALIDATION_ERROR',
  ) {
    super(message);
    this.name = 'ValidationFailure';
  }
}

// A last-write-wins / CAS conflict (a draft already sent, a deadline already decided).
export class ConflictError extends Error {
  constructor(message = 'Conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}
