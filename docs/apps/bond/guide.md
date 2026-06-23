---
title: "Bond (CRM) Guide"
app: bond
generated: "2026-06-23T06:01:51.807Z"
---

# Bond (CRM) Guide


# Bond - CRM

Bond is BigBlueBam's customer relationship management app for tracking contacts, companies, deals, and sales pipeline activity. Work your deals on a drag-and-drop pipeline board, keep a running activity timeline on every contact and company, score leads with your own rules, and read forecast, velocity, and win/loss numbers on the Analytics page. The board auto-selects your default pipeline the moment it loads, so you land on live deals instead of an empty picker.

## Key Features

- **Pipeline Board** with drag-and-drop deal cards across configurable pipeline stages, swimlane grouping by owner or close month, and a default pipeline that loads automatically.
- **Contact and Company Management** with detailed profiles, lifecycle stages, lead scores, activity timelines, and soft-delete with restore.
- **Deal Tracking** with value, probability, expected close date, a computed weighted value, Won/Lost outcomes, and per-stage rotting (stale-deal) detection.
- **Analytics** with total and weighted pipeline, win rate, conversion rates, deal velocity, revenue forecast buckets, and top loss reasons and competitors.
- **Custom Fields** defined per entity type (Contact, Company, or Deal) and applied org-wide, plus **org-wide lead scoring rules** that add or subtract points to compute each contact's score.
- **Duplicate and Stale Deal Detection** that ranks likely-duplicate contacts by confidence and flags deals stuck in a stage beyond their configured threshold.
- **AI agent surface** of over 70 MCP tools covering contact/company/deal CRUD, stage moves, Won/Lost, activity logging, idempotent upsert, dedupe, pipeline and stage admin, custom-field and scoring-rule admin, and the full analytics set.

## Integrations

Bond contacts feed Blast email campaign segments. Deal events (`deal.created`, `deal.stage_changed`, `deal.won`, `deal.lost`, `deal.rotting`, `contact.created`, `contact.upserted`, `activity.logged`) flow to Bolt on the `bond` source, so automation rules can react when a deal closes or rots. A deal's Related panel surfaces linked Bill invoices, Book events, and Bam tasks. Bench dashboards can query Bond data for sales reporting. Across the suite, agents reach Bond through the platform read plane (`search_everything`, `account_view`), run under an identity with heartbeat and `agent_policies` gating, route risky changes through the proposal queue, and preflight visibility with `can_access` before citing Bond records.

## Getting Started

Open Bond from the Launchpad. You start on the Pipeline Board, which loads your default pipeline automatically. If your org has no pipeline yet, open **Bond Settings** and create one; it seeds six default stages (Prospect, Qualified, Proposal, Negotiation, Closed Won, Closed Lost). Add contacts and companies from their lists, then add deals from the board and drag them between stages as they progress. Mark a deal Won or Lost on its detail page, log activities to build a timeline, and use the Analytics page to track pipeline health, forecast, and deal velocity.

## Working together

A presence strip on the deal detail shows who else is on a deal, with a one-tap huddle, and your location in Bond shows in the Bureau virtual office.

## Walkthrough

### Pipeline Board

![Pipeline Board](screenshots/light/01-pipeline-board.png)

### Deal Detail

![Deal Detail](screenshots/light/02-deal-detail.png)

### Contacts List

![Contacts List](screenshots/light/03-contacts-list.png)

### Contact Detail

![Contact Detail](screenshots/light/04-contact-detail.png)

### Companies List

![Companies List](screenshots/light/05-companies-list.png)

### Analytics

![Analytics](screenshots/light/06-analytics.png)


## MCP Tools


# bond MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `bond_add_deal_contact` | Associate a contact with a deal, optionally tagging the contact\ | `id`, `contact_id`, `role` |
| `bond_close_deal_lost` | Mark a deal as lost. Sets closed_at, close_reason, and optionally the competitor who won. Emits a deal.lost event for Bolt automations.  | `id`, `close_reason`, `lost_to_competitor` |
| `bond_close_deal_won` | Mark a deal as won. Sets closed_at, moves to the won stage, and emits a deal.won event for Bolt automations.  | `id`, `close_reason` |
| `bond_create_company` | Create a new CRM company. | `domain`, `industry`, `size_bucket`, `annual_revenue`, `phone`, `website`, `address_line1`, `address_line2`, `city`, `state_region`, `postal_code`, `country`, `owner_id`, `custom_fields` |
| `bond_create_contact` | Create a new CRM contact with identity, classification, and optional company association.  | `first_name`, `last_name`, `email`, `phone`, `title`, `lifecycle_stage`, `lead_source`, `owner_id`, `company_id`, `address_line1`, `address_line2`, `city`, `state_region`, `postal_code`, `country`, `custom_fields` |
| `bond_create_custom_field` | Create a custom field definition for contacts, companies, or deals. Requires admin scope.  | `entity_type`, `field_key`, `label`, `field_type`, `options`, `required`, `sort_order` |
| `bond_create_deal` | Create a new deal in a pipeline.  | `pipeline_id`, `stage_id`, `value`, `currency`, `expected_close_date`, `probability_pct`, `owner_id`, `company_id`, `contact_ids`, `custom_fields` |
| `bond_create_import_mapping` | Record (upsert) a single external-system → Bond-entity import mapping for dedup/lookup. Requires admin scope. This is the JSON mapping primitive, not a CSV/file upload. | `source_system`, `source_id`, `bond_entity_type`, `bond_entity_id` |
| `bond_create_pipeline` | Create a new pipeline, optionally seeding it with stages. Requires admin scope. Each stage may set stage_type ( | `is_default`, `currency`, `stages`, `sort_order`, `stage_type`, `probability_pct`, `rotting_days`, `color` |
| `bond_create_scoring_rule` | Create a lead-scoring rule. Requires admin scope. When a contact matches the condition, score_delta (-100..100) is applied to its lead score. | `condition_field`, `condition_operator`, `condition_value`, `score_delta`, `enabled` |
| `bond_create_stage` | Add a stage to a pipeline. Requires admin scope.  | `pipeline_id`, `sort_order`, `stage_type`, `probability_pct`, `rotting_days`, `color` |
| `bond_delete_activity` | Delete an activity by ID. | `id` |
| `bond_delete_company` | Soft-delete a company.  | `id` |
| `bond_delete_contact` | Soft-delete a contact.  | `id` |
| `bond_delete_custom_field` | Delete a custom field definition. Requires admin scope. | `id` |
| `bond_delete_deal` | Soft-delete a deal.  | `id` |
| `bond_delete_pipeline` | Delete a pipeline. Requires admin scope.  | `id` |
| `bond_delete_scoring_rule` | Delete a lead-scoring rule. Requires admin scope. | `id` |
| `bond_delete_stage` | Delete a stage from a pipeline. Requires admin scope.  | `pipeline_id`, `stage_id` |
| `bond_duplicate_deal` | Duplicate a deal (creates a copy in the same pipeline/stage).  | `id` |
| `bond_get_activity` | Get a single activity by ID. | `id` |
| `bond_get_company` | Get full company detail including associated contacts, deals, and recent activities. | `id` |
| `bond_get_contact` | Get full contact detail including associated companies, deals, and recent activities. | `id` |
| `bond_get_conversion_rates` | Get stage-to-stage conversion rates for a pipeline over an optional date window. | `pipeline_id`, `start_date`, `end_date` |
| `bond_get_custom_field` | Get a single custom field definition by ID. | `id` |
| `bond_get_deal` | Get full deal detail including associated contacts, activities, and stage change history. | `id` |
| `bond_get_deal_related` | Get cross-product records linked to a deal: invoices (Bill), events (Book), and tasks (Bam). Each section is best-effort and returns an empty array if its source is unavailable.  | `id` |
| `bond_get_deal_stage_history` | Get the stage transition history for a deal (each move with timestamp and actor).  | `id` |
| `bond_get_deal_velocity` | Get the average time deals spend in each stage of a pipeline. | `pipeline_id` |
| `bond_get_forecast` | Get revenue forecast from weighted pipeline value, broken into 30/60/90 day buckets based on expected close dates. | `pipeline_id` |
| `bond_get_pipeline` | Get a single pipeline with its stages.  | `id` |
| `bond_get_pipeline_summary` | Get pipeline summary with deal count, total value, and weighted value per stage. | `pipeline_id` |
| `bond_get_stale_deals` | List deals that have exceeded the rotting threshold for their current pipeline stage. Useful for stale deal follow-up automations. | `pipeline_id`, `owner_id`, `limit` |
| `bond_get_user_settings` | Get the calling user\ | none |
| `bond_get_win_loss` | Get win/loss ratio and analysis, optionally scoped to a pipeline and date window. | `pipeline_id`, `start_date`, `end_date` |
| `bond_list_activities` | List CRM activities, optionally filtered by contact, deal, company, or activity type.  | `contact_id`, `deal_id`, `company_id`, `activity_type`, `limit`, `offset` |
| `bond_list_companies` | Search and filter CRM companies with pagination. | `search`, `industry`, `size_bucket`, `owner_id`, `sort`, `cursor`, `limit` |
| `bond_list_company_contacts` | List the contacts associated with a company.  | `id` |
| `bond_list_company_deals` | List the deals attached to a company (paginated).  | `id`, `limit`, `offset`, `sort` |
| `bond_list_contacts` | Search and filter CRM contacts with pagination. Supports lifecycle stage, owner, company, lead score range, and custom field filters. | `lifecycle_stage`, `owner_id`, `company_id`, `lead_source`, `lead_score_min`, `lead_score_max`, `search`, `sort`, `cursor`, `limit` |
| `bond_list_custom_fields` | List custom field definitions, optionally filtered to one entity type (contact, company, or deal). | `entity_type` |
| `bond_list_deal_activities` | List the activity timeline for a deal (notes, calls, emails, meetings, stage changes).  | `id` |
| `bond_list_deal_contacts` | List the contacts associated with a deal (with their per-deal role).  | `id` |
| `bond_list_deals` | Search and filter CRM deals with pagination. Supports pipeline, stage, owner, value range, and stale flag filters. | `pipeline_id`, `stage_id`, `owner_id`, `company_id`, `contact_id`, `value_min`, `value_max`, `expected_close_before`, `expected_close_after`, `is_open`, `sort`, `cursor`, `limit` |
| `bond_list_import_mappings` | List external-system → Bond-entity import mappings for the org, optionally filtered by source system. | `source_system`, `limit`, `offset` |
| `bond_list_pipelines` | List all CRM pipelines for the org, each with its ordered stages. | none |
| `bond_list_scoring_rules` | List the lead-scoring rules configured for the org. | none |
| `bond_list_stages` | List the ordered stages of a pipeline.  | `pipeline_id` |
| `bond_log_activity` | Log an activity (note, call, email, meeting, task, etc.) against a contact, deal, or both.  | `activity_type`, `contact_id`, `deal_id`, `company_id`, `subject`, `body`, `performed_at`, `metadata` |
| `bond_merge_contacts` | Merge duplicate contacts. The target contact absorbs the source contact\ | `target_id`, `source_id` |
| `bond_move_deal_stage` | Move a deal to a new pipeline stage. Records stage history and emits a deal.stage_changed event for Bolt automations.  | `id`, `stage_id` |
| `bond_remove_deal_contact` | Remove a contact association from a deal.  | `id`, `contact_id` |
| `bond_reorder_stages` | Reorder a pipeline\ | `pipeline_id`, `stage_ids` |
| `bond_restore_company` | Undelete a previously soft-deleted company.  | `id` |
| `bond_restore_contact` | Undelete a previously soft-deleted contact.  | `id` |
| `bond_restore_deal` | Undelete a previously soft-deleted deal.  | `id` |
| `bond_score_lead` | Trigger lead score recalculation for a specific contact. Evaluates all enabled scoring rules and updates the cached lead_score on the contact. | `contact_id` |
| `bond_search_companies` | Full-text search across company name and domain. Lightweight typeahead-style lookup; for filtered/paginated browsing use bond_list_companies. | `query`, `limit` |
| `bond_search_contacts` | Full-text search across contact name, email, and phone. Returns contacts ranked by lead score. | `query`, `limit` |
| `bond_update_activity` | Update an activity\ | `id`, `subject`, `body`, `metadata` |
| `bond_update_company` | Update an existing company. Provide only the fields to change. | `id`, `domain`, `industry`, `size_bucket`, `annual_revenue`, `phone`, `website`, `address_line1`, `address_line2`, `city`, `state_region`, `postal_code`, `country`, `owner_id`, `custom_fields` |
| `bond_update_contact` | Update an existing contact. Provide only the fields to change.  | `id`, `first_name`, `last_name`, `email`, `phone`, `title`, `lifecycle_stage`, `lead_source`, `owner_id`, `address_line1`, `address_line2`, `city`, `state_region`, `postal_code`, `country`, `custom_fields` |
| `bond_update_custom_field` | Update a custom field definition. Requires admin scope. Provide only the fields to change (the entity_type and field_key are immutable). | `id`, `label`, `field_type`, `options`, `required`, `sort_order` |
| `bond_update_deal` | Update an existing deal. Provide only the fields to change.  | `id`, `value`, `currency`, `expected_close_date`, `probability_pct`, `owner_id`, `company_id`, `custom_fields` |
| `bond_update_pipeline` | Update a pipeline\ | `id`, `is_default`, `currency` |
| `bond_update_scoring_rule` | Update a lead-scoring rule. Requires admin scope. Provide only the fields to change. | `id`, `condition_field`, `condition_operator`, `condition_value`, `score_delta`, `enabled` |
| `bond_update_stage` | Update a pipeline stage. Requires admin scope.  | `pipeline_id`, `stage_id`, `sort_order`, `stage_type`, `probability_pct`, `rotting_days`, `color` |
| `bond_update_user_settings` | Set or clear the calling user\ | `reply_to_email` |
| `bond_upsert_contact` | Idempotent create-or-update of a CRM contact by email. Natural key is (organization_id, lower(email)). Soft-deleted matches are resurrected. Returns { data, created, idempotency_key } —  | `email`, `first_name`, `last_name`, `phone`, `title`, `avatar_url`, `lifecycle_stage`, `lead_source`, `address_line1`, `address_line2`, `city`, `state_region`, `postal_code`, `country`, `custom_fields`, `owner_id` |

## Related Apps

- [Bench (Analytics)](../bench/guide.md)
- [Bill (Invoicing)](../bill/guide.md)
- [Blank (Forms)](../blank/guide.md)
- [Blast (Email Campaigns)](../blast/guide.md)
- [Blueprint](../blueprint/guide.md)
- [Bolt (Workflow Automation)](../bolt/guide.md)
- [Book (Scheduling)](../book/guide.md)
- [Bureau](../bureau/guide.md)
- [Introduction to BigBlueBam](../introduction/guide.md)
