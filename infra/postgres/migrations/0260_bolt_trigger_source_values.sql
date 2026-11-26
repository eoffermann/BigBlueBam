-- 0260_bolt_trigger_source_values.sql
-- Why: Issue #124. The bolt_trigger_source enum stopped at 'platform' (0121) while
-- eleven more apps publish or will publish Bolt events. bolt-api compares
-- bolt_automations.trigger_source against the ingested source, so an event whose
-- source is missing from this enum cannot match any rule. The source list now
-- lives once in packages/shared/src/bolt-sources.ts (BOLT_SOURCES); this file
-- brings the database enum up to that list, and scripts/check-bolt-enum.mjs
-- (db-drift CI) fails if the two ever diverge again.
-- Client impact: additive only. Extends an existing enum; no new value is used
-- in this file (ADD VALUE cannot be used in the same transaction that adds it).

ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'burn';
ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'bulwark';
ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'braid';
ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'basis';
ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'blip';
ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'blueprint';
ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'bureau';
ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'bin';
ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'bay';
ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'bursar';
ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'bastion';
