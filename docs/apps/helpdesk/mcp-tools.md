# helpdesk MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `get_ticket` | Get detailed information about a helpdesk ticket including messages | `ticket_id` |
| `helpdesk_get_public_settings` | Get public helpdesk settings (no auth required). Returns email verification requirement, categories, and welcome message. | none |
| `helpdesk_get_settings` | Get full helpdesk configuration. Requires admin authentication — the caller\ | none |
| `helpdesk_get_ticket_by_number` | Resolve a helpdesk ticket by its human-readable ticket number (e.g. 1234 or #1234). Leading  | `number` |
| `helpdesk_search_tickets` | Fuzzy search helpdesk tickets by subject and body within the caller\ | `query`, `status`, `assignee_id` |
| `helpdesk_set_default_project` | Set the default project for incoming helpdesk tickets for a specific organization. Identifies the org by slug (e.g.  | `org_slug`, `project_slug` |
| `helpdesk_update_settings` | Update helpdesk settings. Requires admin authentication. | `categories`, `welcome_message`, `require_email_verification`, `allowed_email_domains` |
| `helpdesk_upsert_user` | Idempotent create-or-update of a helpdesk end-user by email. Natural key is (org_id, email); the tool resolves the org via the provided org_slug. Returns { data, created, idempotency_key }. SECURITY: the update path ignores the password field, so calling this tool on an existing email cannot change that user\ | `org_slug`, `email`, `display_name`, `password`, `email_verified`, `is_active` |
| `list_tickets` | List helpdesk tickets with optional filters | `status`, `assignee_id`, `client_id`, `cursor`, `limit` |
| `reply_to_ticket` | Send a message on a helpdesk ticket (public reply or internal note) | `ticket_id`, `body`, `is_internal` |
| `update_ticket_status` | Update the status of a helpdesk ticket | `ticket_id`, `status` |
