-- 0364_bastion_export_dismiss.sql
-- Why: Bastion's Sharing page listed every audit packet, including ones that could not be built,
--   with no way to clear them (#402). A person can now dismiss a failed packet: it is hidden from
--   the default list (soft-hide, audited as export.dismiss), never deleted, and a packet that was
--   built can never be dismissed.
-- Client impact: additive only. Two nullable columns and a CHECK that only a not-built packet can
--   carry a dismissal; existing rows keep both columns NULL.

ALTER TABLE bastion_export_packets ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;
ALTER TABLE bastion_export_packets ADD COLUMN IF NOT EXISTS dismissed_by UUID REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
    ALTER TABLE bastion_export_packets
        ADD CONSTRAINT bastion_export_packets_dismiss_not_built
        CHECK (dismissed_at IS NULL OR status <> 'succeeded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
