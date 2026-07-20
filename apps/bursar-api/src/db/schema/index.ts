// Bursar Drizzle schema barrel.
//
// M0 ships the scaffold only: every `bursar_*` table lands at M1 alongside its migration,
// so this barrel is intentionally empty until then. Keeping it present (rather than
// letting db/index.ts import a missing module) means the drift guard's schema-root
// auto-discovery already sees apps/bursar-api/src/db/schema/ and will pick the tables up
// the moment they are written.
export {};
