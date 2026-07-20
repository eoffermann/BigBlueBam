# bond MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `bond_add_deal_contact` | Associate a contact with a deal, optionally tagging the contact's role (e.g. "decision_maker", "champion"). `id` accepts a deal UUID or title fragment; `contact_id` accepts a contact UUID, email, or unique name fragment. | `id`, `contact_id`, `role` |
| `bond_close_deal_lost` | Mark a deal as lost. Sets closed_at, close_reason, and optionally the competitor who won. Emits a deal.lost event for Bolt automations. `id` accepts a deal UUID or a unique title fragment. | `id`, `close_reason`, `lost_to_competitor` |
| `bond_close_deal_won` | Mark a deal as won. Sets closed_at, moves to the won stage, and emits a deal.won event for Bolt automations. `id` accepts a deal UUID or a unique title fragment. | `id`, `close_reason` |
| `bond_create_company` | Create a new CRM company. | `domain`, `industry`, `size_bucket`, `annual_revenue`, `phone`, `website`, `address_line1`, `address_line2`, `city`, `state_region`, `postal_code`, `country`, `owner_id`, `custom_fields` |
| `bond_create_contact` | Create a new CRM contact with identity, classification, and optional company association. `owner_id` accepts a user UUID or email; `company_id` accepts a company UUID or name. | `first_name`, `last_name`, `email`, `phone`, `title`, `lifecycle_stage`, `lead_source`, `owner_id`, `company_id`, `address_line1`, `address_line2`, `city`, `state_region`, `postal_code`, `country`, `custom_fields` |
| `bond_create_custom_field` | Create a custom field definition for contacts, companies, or deals. Requires admin scope. `field_key` must be lowercase snake_case starting with a letter. select/multi_select types take an `options` list. | `entity_type`, `field_key`, `label`, `field_type`, `options`, `required`, `sort_order` |
| `bond_create_deal` | Create a new deal in a pipeline. `pipeline_id` accepts a pipeline UUID or exact name; `stage_id` accepts a stage UUID or exact name (within the resolved pipeline); `owner_id` accepts a user UUID or email; `company_id` accepts a company UUID or name; `contact_ids` entries each accept a contact UUID or email. | `pipeline_id`, `stage_id`, `value`, `currency`, `expected_close_date`, `probability_pct`, `owner_id`, `company_id`, `contact_ids`, `custom_fields` |
| `bond_create_import_mapping` | Record (upsert) a single external-system → Bond-entity import mapping for dedup/lookup. Requires admin scope. This is the JSON mapping primitive, not a CSV/file upload. | `source_system`, `source_id`, `bond_entity_type`, `bond_entity_id` |
| `bond_create_pipeline` | Create a new pipeline, optionally seeding it with stages. Requires admin scope. Each stage may set stage_type ("active"/"won"/"lost"), probability, and rotting threshold. | `is_default`, `currency`, `stages`, `sort_order`, `stage_type`, `probability_pct`, `rotting_days`, `color` |
| `bond_create_scoring_rule` | Create a lead-scoring rule. Requires admin scope. When a contact matches the condition, score_delta (-100..100) is applied to its lead score. | `condition_field`, `condition_operator`, `condition_value`, `score_delta`, `enabled` |
| `bond_create_stage` | Add a stage to a pipeline. Requires admin scope. `pipeline_id` accepts a pipeline UUID or an exact name. | `pipeline_id`, `sort_order`, `stage_type`, `probability_pct`, `rotting_days`, `color` |
| `bond_delete_activity` | Delete an activity by ID. | `id` |
| `bond_delete_company` | Soft-delete a company. `id` accepts a company UUID or an exact/unique company name. Use bond_restore_company to undo. | `id` |
| `bond_delete_contact` | Soft-delete a contact. `id` accepts a contact UUID, an email, or a unique name fragment (single-match only). Use bond_restore_contact to undo. | `id` |
| `bond_delete_custom_field` | Delete a custom field definition. Requires admin scope. | `id` |
| `bond_delete_deal` | Soft-delete a deal. `id` accepts a deal UUID or a unique title fragment (single-match only). Use bond_restore_deal to undo. | `id` |
| `bond_delete_pipeline` | Delete a pipeline. Requires admin scope. `id` accepts a pipeline UUID or an exact name. | `id` |
| `bond_delete_scoring_rule` | Delete a lead-scoring rule. Requires admin scope. | `id` |
| `bond_delete_stage` | Delete a stage from a pipeline. Requires admin scope. `pipeline_id` accepts a pipeline UUID or exact name; `stage_id` accepts a stage UUID or exact stage name within the pipeline. | `pipeline_id`, `stage_id` |
| `bond_duplicate_deal` | Duplicate a deal (creates a copy in the same pipeline/stage). `id` accepts a deal UUID or a unique title fragment. | `id` |
| `bond_get_activity` | Get a single activity by ID. | `id` |
| `bond_get_company` | Get full company detail including associated contacts, deals, and recent activities. | `id` |
| `bond_get_contact` | Get full contact detail including associated companies, deals, and recent activities. | `id` |
| `bond_get_conversion_rates` | Get stage-to-stage conversion rates for a pipeline over an optional date window. | `pipeline_id`, `start_date`, `end_date` |
| `bond_get_custom_field` | Get a single custom field definition by ID. | `id` |
| `bond_get_deal` | Get full deal detail including associated contacts, activities, and stage change history. | `id` |
| `bond_get_deal_related` | Get cross-product records linked to a deal: invoices (Bill), events (Book), and tasks (Bam). Each section is best-effort and returns an empty array if its source is unavailable. `id` accepts a deal UUID or a unique title fragment. | `id` |
| `bond_get_deal_stage_history` | Get the stage transition history for a deal (each move with timestamp and actor). `id` accepts a deal UUID or a unique title fragment. | `id` |
| `bond_get_deal_velocity` | Get the average time deals spend in each stage of a pipeline. | `pipeline_id` |
| `bond_get_forecast` | Get revenue forecast from weighted pipeline value, broken into 30/60/90 day buckets based on expected close dates. | `pipeline_id` |
| `bond_get_pipeline` | Get a single pipeline with its stages. `id` accepts a pipeline UUID or an exact pipeline name. | `id` |
| `bond_get_pipeline_summary` | Get pipeline summary with deal count, total value, and weighted value per stage. | `pipeline_id` |
| `bond_get_stale_deals` | List deals that have exceeded the rotting threshold for their current pipeline stage. Useful for stale deal follow-up automations. | `pipeline_id`, `owner_id`, `limit` |
| `bond_get_user_settings` | Get the calling user's own Bond settings (e.g. reply-to email). | none |
| `bond_get_win_loss` | Get win/loss ratio and analysis, optionally scoped to a pipeline and date window. | `pipeline_id`, `start_date`, `end_date` |
| `bond_list_activities` | List CRM activities, optionally filtered by contact, deal, company, or activity type. `contact_id`/`deal_id`/`company_id` must be UUIDs. | `contact_id`, `deal_id`, `company_id`, `activity_type`, `limit`, `offset` |
| `bond_list_companies` | Search and filter CRM companies with pagination. | `search`, `industry`, `size_bucket`, `owner_id`, `sort`, `cursor`, `limit` |
| `bond_list_company_contacts` | List the contacts associated with a company. `id` accepts a company UUID or a unique company name. | `id` |
| `bond_list_company_deals` | List the deals attached to a company (paginated). `id` accepts a company UUID or a unique company name. | `id`, `limit`, `offset`, `sort` |
| `bond_list_contacts` | Search and filter CRM contacts with pagination. Supports lifecycle stage, owner, company, lead score range, and custom field filters. | `lifecycle_stage`, `owner_id`, `company_id`, `lead_source`, `lead_score_min`, `lead_score_max`, `search`, `sort`, `cursor`, `limit` |
| `bond_list_custom_fields` | List custom field definitions, optionally filtered to one entity type (contact, company, or deal). | `entity_type` |
| `bond_list_deal_activities` | List the activity timeline for a deal (notes, calls, emails, meetings, stage changes). `id` accepts a deal UUID or a unique title fragment. | `id` |
| `bond_list_deal_contacts` | List the contacts associated with a deal (with their per-deal role). `id` accepts a deal UUID or a unique title fragment. | `id` |
| `bond_list_deals` | Search and filter CRM deals with pagination. Supports pipeline, stage, owner, value range, and stale flag filters. | `pipeline_id`, `stage_id`, `owner_id`, `company_id`, `contact_id`, `value_min`, `value_max`, `expected_close_before`, `expected_close_after`, `is_open`, `sort`, `cursor`, `limit` |
| `bond_list_import_mappings` | List external-system → Bond-entity import mappings for the org, optionally filtered by source system. | `source_system`, `limit`, `offset` |
| `bond_list_pipelines` | List all CRM pipelines for the org, each with its ordered stages. | none |
| `bond_list_scoring_rules` | List the lead-scoring rules configured for the org. | none |
| `bond_list_stages` | List the ordered stages of a pipeline. `pipeline_id` accepts a pipeline UUID or an exact name. | `pipeline_id` |
| `bond_log_activity` | Log an activity (note, call, email, meeting, task, etc.) against a contact, deal, or both. `contact_id` accepts a UUID or email; `deal_id` accepts a UUID or unique deal title fragment; `company_id` accepts a UUID or company name. | `activity_type`, `contact_id`, `deal_id`, `company_id`, `subject`, `body`, `performed_at`, `metadata` |
| `bond_merge_contacts` | Merge duplicate contacts. The target contact absorbs the source contact's deals, activities, and company associations. The source contact is soft-deleted. | `target_id`, `source_id` |
| `bond_move_deal_stage` | Move a deal to a new pipeline stage. Records stage history and emits a deal.stage_changed event for Bolt automations. `id` accepts a deal UUID or a unique title fragment; `stage_id` accepts a stage UUID or exact stage name (stage name is resolved within the deal's pipeline). | `id`, `stage_id` |
| `bond_remove_deal_contact` | Remove a contact association from a deal. `id` accepts a deal UUID or title fragment; `contact_id` accepts a contact UUID, email, or unique name fragment. | `id`, `contact_id` |
| `bond_reorder_stages` | Reorder a pipeline's stages. Requires admin scope. `pipeline_id` accepts a pipeline UUID or an exact name; `stage_ids` is the full ordered list of stage UUIDs. | `pipeline_id`, `stage_ids` |
| `bond_restore_company` | Undelete a previously soft-deleted company. `id` must be the company UUID (a deleted company will not surface in name search). | `id` |
| `bond_restore_contact` | Undelete a previously soft-deleted contact. `id` must be the contact UUID (a deleted contact will not surface in name/email search). | `id` |
| `bond_restore_deal` | Undelete a previously soft-deleted deal. `id` must be the deal UUID (a deleted deal will not surface in title search). | `id` |
| `bond_score_lead` | Trigger lead score recalculation for a specific contact. Evaluates all enabled scoring rules and updates the cached lead_score on the contact. | `contact_id` |
| `bond_search_companies` | Full-text search across company name and domain. Lightweight typeahead-style lookup; for filtered/paginated browsing use bond_list_companies. | `query`, `limit` |
| `bond_search_contacts` | Full-text search across contact name, email, and phone. Returns contacts ranked by lead score. | `query`, `limit` |
| `bond_update_activity` | Update an activity's subject, body, or metadata. Provide only the fields to change. | `id`, `subject`, `body`, `metadata` |
| `bond_update_company` | Update an existing company. Provide only the fields to change. | `id`, `domain`, `industry`, `size_bucket`, `annual_revenue`, `phone`, `website`, `address_line1`, `address_line2`, `city`, `state_region`, `postal_code`, `country`, `owner_id`, `custom_fields` |
| `bond_update_contact` | Update an existing contact. Provide only the fields to change. `id` accepts a contact UUID, an email, or a name fragment (single-match only). `owner_id` accepts a user UUID or email. | `id`, `first_name`, `last_name`, `email`, `phone`, `title`, `lifecycle_stage`, `lead_source`, `owner_id`, `address_line1`, `address_line2`, `city`, `state_region`, `postal_code`, `country`, `custom_fields` |
| `bond_update_custom_field` | Update a custom field definition. Requires admin scope. Provide only the fields to change (the entity_type and field_key are immutable). | `id`, `label`, `field_type`, `options`, `required`, `sort_order` |
| `bond_update_deal` | Update an existing deal. Provide only the fields to change. `id` accepts a deal UUID or a unique title fragment (single-match only). `owner_id` accepts a user UUID or email; `company_id` accepts a company UUID or name. | `id`, `value`, `currency`, `expected_close_date`, `probability_pct`, `owner_id`, `company_id`, `custom_fields` |
| `bond_update_pipeline` | Update a pipeline's metadata. Requires admin scope. Provide only the fields to change. `id` accepts a pipeline UUID or an exact name. | `id`, `is_default`, `currency` |
| `bond_update_scoring_rule` | Update a lead-scoring rule. Requires admin scope. Provide only the fields to change. | `id`, `condition_field`, `condition_operator`, `condition_value`, `score_delta`, `enabled` |
| `bond_update_stage` | Update a pipeline stage. Requires admin scope. `pipeline_id` accepts a pipeline UUID or an exact name; `stage_id` accepts a stage UUID or an exact stage name within that pipeline. Provide only the fields to change. | `pipeline_id`, `stage_id`, `sort_order`, `stage_type`, `probability_pct`, `rotting_days`, `color` |
| `bond_update_user_settings` | Set or clear the calling user's Bond reply-to email address. Pass an empty string or null to clear it. | `reply_to_email` |
| `bond_upsert_contact` | Idempotent create-or-update of a CRM contact by email. Natural key is (organization_id, lower(email)). Soft-deleted matches are resurrected. Returns { data, created, idempotency_key } — `created` is true on insert, false on update. | `email`, `first_name`, `last_name`, `phone`, `title`, `avatar_url`, `lifecycle_stage`, `lead_source`, `address_line1`, `address_line2`, `city`, `state_region`, `postal_code`, `country`, `custom_fields`, `owner_id` |
