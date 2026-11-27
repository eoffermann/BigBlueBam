// A response shape as a bastion-api service builds it (#371).
//
// The shared response schemas in @bigbluebam/shared (packages/shared/src/schemas/bastion.ts)
// describe the wire: what the route sends after JSON.stringify, where a timestamp is an ISO string.
// A service usually holds those timestamps as Date (postgres and drizzle both return Date), and
// JSON turns a Date into exactly that ISO string. Served<T> is T with "string, or a Date that will
// serialize to one" on the timestamp fields (named *_at, valid_until, as_of, window_start,
// window_end, current_through), so a service's return type can be the shared shape without
// converting every timestamp by hand. Everything else (ids, numbers, booleans, enums, field
// presence) is checked exactly as the wire has it: a bigint column left as a string does not
// compile where the schema says number.

/** The field names Bastion uses for timestamptz columns. */
type TimestampKey = `${string}_at` | 'valid_until' | 'as_of' | 'window_start' | 'window_end' | 'current_through';

type ServedTimestamp<V> = V extends string ? (string extends V ? V | Date : V) : V;

export type Served<T> = T extends readonly (infer U)[]
  ? Served<U>[]
  : T extends object
    ? { [K in keyof T]: K extends TimestampKey ? ServedTimestamp<T[K]> : Served<T[K]> }
    : T;

/** A bigint column arrives from postgres as a string; the wire carries a number. */
export function int(v: unknown): number {
  return Number(v);
}

/** As int, keeping null (and undefined) as null. */
export function intOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}
