// What makes a Bam phase "open": a task can be filed (or reopened) into it (#229, #253).
//
// The api's /internal/bastion task upsert (apps/api/src/services/bastion-internal.service.ts,
// startPhase) is the rule that decides; Bastion asks the same question before it lets a project be
// the Compliance project (setup.service.ts), for the Readiness banner (coverage.service.ts) and for
// the re-drive gate (remediation.ts redriveProjectDeliveries). All of them read this one predicate,
// so a change here (say, also skipping archived phases) changes every one of them together.
// scripts/lib/open-phase-rule.test.mjs fails if the predicate is written out anywhere else.
//
// A SQL boolean over the columns of `phases` (unqualified). It is a constant with no user input;
// callers splice it in with drizzle `sql.raw()` or postgres.js `tx.unsafe()`.

export const BAM_OPEN_PHASE_SQL = '(is_start OR NOT is_terminal)';
