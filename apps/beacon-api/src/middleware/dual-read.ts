// Wave E.E: dualReadGate has been removed (Waves E.A/E.B replaced every
// call site with bare 'fastify.requireCan(...)'). shadowOnly remains for
// routes that previously had no role gate — it lets the resolver record
// telemetry without enforcement during the warn-mode soak.
//
// Re-exports the shared @bigbluebam/permissions implementation so existing
// imports from '../middleware/dual-read.js' keep working without churn.

export { shadowOnly } from '@bigbluebam/permissions';
