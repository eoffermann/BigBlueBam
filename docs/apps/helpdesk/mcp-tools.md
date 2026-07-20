# helpdesk MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `get_ticket` | Get detailed information about a helpdesk ticket including messages | `ticket_id` |
| `helpdesk_get_public_settings` | Get public helpdesk settings (no auth required). Returns email verification requirement, categories, and welcome message. | none |
| `helpdesk_get_settings` | Get full helpdesk configuration. Requires admin authentication — the caller's API key must belong to an org admin or owner. | none |
| `helpdesk_get_ticket_by_number` | Resolve a helpdesk ticket by its human-readable ticket number (e.g. 1234 or #1234). Leading "#" is stripped. Returns the full ticket record enriched with requester and task-derived assignee info, or null if not found. Use this when you only have the ticket number (as typically shown to customers or agents) and need to resolve it to the underlying UUID / full record before calling other helpdesk tools. | `number` |
| `helpdesk_search_tickets` | Fuzzy search helpdesk tickets by subject and body within the caller's org. Returns up to 20 matches as a compact projection ({ id, number, subject, status, priority, requester_email, requester_name, assignee_id, assignee_name }), ordered by most recently updated. Optional filters narrow by status and by the linked task's assignee_id. Intended as a resolver for natural-language ticket lookups where only a fragment of the subject/body is known. | `query`, `status`, `assignee_id` |
| `helpdesk_set_default_project` | Set the default project for incoming helpdesk tickets for a specific organization. Identifies the org by slug (e.g. "mage-inc") and the project by slug (e.g. "support-backlog"). Future tickets submitted at /helpdesk/<org-slug>/ (no project segment) will land in this project. Per-project portal URLs (/helpdesk/<org-slug>/<project-slug>/) override this default. Requires admin authentication. | `org_slug`, `project_slug` |
| `helpdesk_update_settings` | Update helpdesk settings. Requires admin authentication. | `categories`, `welcome_message`, `require_email_verification`, `allowed_email_domains` |
| `helpdesk_upsert_user` | Idempotent create-or-update of a helpdesk end-user by email. Natural key is (org_id, email); the tool resolves the org via the provided org_slug. Returns { data, created, idempotency_key }. SECURITY: the update path ignores the password field, so calling this tool on an existing email cannot change that user's credentials. | `org_slug`, `email`, `display_name`, `password`, `email_verified`, `is_active` |
| `list_tickets` | List helpdesk tickets with optional filters | `status`, `assignee_id`, `client_id`, `cursor`, `limit` |
| `reply_to_ticket` | Send a message on a helpdesk ticket (public reply or internal note) | `ticket_id`, `body`, `is_internal` |
| `update_ticket_status` | Update the status of a helpdesk ticket | `ticket_id`, `status` |
