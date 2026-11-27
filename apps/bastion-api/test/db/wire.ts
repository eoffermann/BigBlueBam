import { expect } from 'vitest';
import type { ZodTypeAny } from 'zod';

/** A service result as the route sends it: through JSON, so a Date is an ISO string (#348, #371). */
export const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/**
 * The invariant #371 protects, checked where it matters: what the route would send (the service
 * result through JSON) parses as the shared response schema the SPA and the MCP tools are typed
 * from. A bigint left as a string, a missing field or a wrong enum fails here with the zod path.
 */
export function expectWire(schema: ZodTypeAny, value: unknown): void {
  const parsed = schema.safeParse(wire(value));
  expect(parsed.success ? null : parsed.error.issues.slice(0, 5)).toBeNull();
}
