# 2026-04-14 Migration Number Ledger

Authoritative registry of migration numbers for the 2026-04-14 recovery orchestration push. Claims start at **0079** (the committed tree at `a8fb19a` has `0078_reconcile_bam_bearing_drift.sql` as the highest migration). All numbers 0047 through 0077 are unclaimed at a8fb19a and are available from 0079 onward.

## Claim policy

- Each per-app or platform plan in `docs/plans/2026-04-14/` declares its migration needs in its "Migrations" section, with specific numbers claimed from this ledger.
- Claim numbers sequentially. When a plan is committed, update this ledger in the **same commit** to record the claim.
- Migration filenames must match `^[0-9]{4}_[a-z][a-z0-9_]*\.sql$`.
- Every migration must be idempotent and carry the `-- Why:` / `-- Client impact:` header.
- Never edit a committed migration file.

## Claimed / assigned

| Number | File | Plan | Wave | Status |
|---|---|---|---|---|
| 0079 | `0079_beacon_comments_table.sql` | Beacon_Plan.md (G1) | Wave 2.01 | claimed |
| 0080 | `0080_beacon_attachments_table.sql` | Beacon_Plan.md (G2) | Wave 2.01 | claimed |
| 0081 | _(released, was Beacon reserve)_ | Beacon_Plan.md | - | released |
| 0082 | _(released, was Beacon reserve)_ | Beacon_Plan.md | - | released |
| 0083 | `0083_bearing_watcher_unsubscribe_token.sql` | Bearing_Plan.md (G9 conditional) | Wave 2.02 | conditional |
| 0084 | `0084_bench_report_delivery_tracking.sql` | Bench_Plan.md | Wave 2.03 | claimed |
| 0085 | `0085_bench_materialized_view_refresh_tracking.sql` | Bench_Plan.md | Wave 2.03 | claimed |
| 0086 | `0086_bill_pdf_storage_and_locks.sql` | Bill_Plan.md | Wave 2.04 | claimed |
| 0087 | `0087_bill_expense_receipt_metadata.sql` | Bill_Plan.md | Wave 2.04 | claimed |
| 0088 | `0088_bill_worker_job_state.sql` | Bill_Plan.md | Wave 2.04 | claimed |
| 0089 | `0089_blank_file_processing_status.sql` | Blank_Plan.md | Wave 2.05 | claimed |
| 0090 | `0090_blank_submission_event_emission.sql` | Blank_Plan.md | Wave 2.05 | claimed |
| 0091 | `0091_blast_engagement_event_indexes.sql` | Blast_Plan.md | Wave 2.06 | claimed |
| 0092 | `0092_blast_campaign_completion_tracking.sql` | Blast_Plan.md | Wave 2.06 | claimed |
| 0093 | `0093_board_template_content.sql` | Board_Plan.md (G4) | Wave 2.07 | claimed |
| 0094 | `0094_board_element_count_tracking.sql` | Board_Plan.md (G10, P1) | Wave 2.07 | claimed (P1) |
| 0095 | _(released, was Board reserve)_ | Board_Plan.md | - | released |
| 0096 | `0096_bolt_event_naming_migration.sql` | Bolt_Plan.md (G3) | Wave 2.08 | claimed |
| 0097 | `0097_bolt_notify_owner_on_failure.sql` | Bolt_Plan.md (G8) | Wave 2.08 | claimed |
| 0098 | _(released, was Bolt reserve)_ | Bolt_Plan.md | - | released |
| 0099 | `0099_bond_import_mappings.sql` | Bond_Plan.md (G1) | Wave 2.09 | claimed |
| 0100 | `0100_bond_soft_delete.sql` | Bond_Plan.md (G4) | Wave 2.09 | claimed |
| 0101 | _(released, was Book reserve)_ | Book_Plan.md | - | released |
| 0102 | _(released, was Book reserve)_ | Book_Plan.md | - | released |
| 0103 | `0103_brief_yjs_state_tracking.sql` | Brief_Plan.md (G1) | Wave 2.11 | claimed |
| 0104 | `0104_brief_qdrant_embedded_at.sql` | Brief_Plan.md (G3) | Wave 2.11 | claimed |
| 0105 | `0105_banter_user_presence.sql` | Banter_Plan.md (G8) | Wave 2.12 | claimed |
| 0106 | `0106_banter_future_message_partitions.sql` | Banter_Plan.md (G10) | Wave 2.12 | claimed |
| 0107 | `0107_banter_channel_viewer_role.sql` | Banter_Plan.md | Wave 2.12 | claimed |
| 0108 | `0108_banter_message_edit_permissions.sql` | Banter_Plan.md | Wave 2.12 | claimed |
| 0109 | `0109_helpdesk_users_org_id.sql` | Helpdesk_Plan.md (G2) | Wave 2.13 | claimed |
| 0110 | `0110_helpdesk_users_org_id_constraint.sql` | Helpdesk_Plan.md (G2) | Wave 2.13 | claimed |
| 0111 | `0111_helpdesk_sla_tracking.sql` | Helpdesk_Plan.md (G4) | Wave 2.13 | claimed |
| 0112 | `0112_helpdesk_ticket_fulltext.sql` | Helpdesk_Plan.md (G5) | Wave 2.13 | claimed |
| 0113 | `0113_helpdesk_email_verification_hashing.sql` | Helpdesk_Plan.md (G7) | Wave 2.13 | claimed |
| 0114 | `0114_helpdesk_ticket_attachments.sql` | Helpdesk_Plan.md (G6) | Wave 2.13 | claimed |
| 0115 | `0115_helpdesk_ticket_events_bolt.sql` | Helpdesk_Plan.md (G3) | Wave 2.13 | claimed |
| 0116 | `0116_rls_foundation.sql` | Platform_Plan.md (G1) | Wave 1.A | claimed |
| 0117 | `0117_api_key_rotation.sql` | Platform_Plan.md (G3) | Wave 1.A | claimed |
| 0118 | `0118_oauth_providers.sql` | Platform_Plan.md (G2) | Wave 1.A | claimed |
| 0119 | `0119_oauth_user_links.sql` | Platform_Plan.md (G2) | Wave 1.A | claimed |
| 0120-0129 | _(reserved for Cross_Product follow-ups)_ | Cross_Product_Plan.md | - | reserved |

## Overflow pool

If two plans need the same number due to simultaneous claims during Step 2 planning, the plan committed second claims the next sequential number and updates its own Migrations section accordingly. The orchestrator reconciles at merge time.

## Stale ledger reference

`docs/plans/2026-04-13-revised/MIGRATION_LEDGER.md` is from the rolled-back 2026-04-13 attempt. It reserved numbers 0047-0077 but none of those migrations were ever committed to a surviving branch. Treat that ledger as archaeology, not authority. Per DECISIONS.md D-003, the new ledger starts fresh at 0079.
