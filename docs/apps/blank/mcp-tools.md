# blank MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `blank_add_field` | Add a single field to an existing form. `field_key` must be a safe identifier (letters, digits, underscores; starting with a letter or underscore). | `form_id`, `field_key`, `label`, `field_type`, `placeholder`, `required`, `min_length`, `max_length`, `options`, `scale_min`, `scale_max`, `scale_min_label`, `scale_max_label`, `conditional_on_field_id`, `conditional_operator`, `conditional_value`, `sort_order`, `page_number`, `column_span`, `default_value` |
| `blank_close_form` | Close a published form to new submissions. Existing submissions are retained; the form stops accepting responses. | `id` |
| `blank_create_form` | Create a new form with optional inline field definitions. | `slug`, `form_type`, `fields`, `field_key`, `label`, `field_type`, `required`, `options`, `scale_min`, `scale_max`, `scale_min_label`, `scale_max_label` |
| `blank_delete_field` | Delete a single field from a form. This is destructive and removes the field definition. | `id` |
| `blank_delete_form` | Delete a form and all of its fields and submissions. This is destructive and cannot be undone. | `id` |
| `blank_delete_submission` | Delete a single form submission. This is destructive and cannot be undone. | `id` |
| `blank_duplicate_form` | Clone an existing form (including its fields) into a new draft form owned by the current user. | `id` |
| `blank_export_submissions` | Export all submissions for a form as CSV data. | `form_id` |
| `blank_generate_form` | AI generates a form from a natural-language description. Returns a form specification that can be passed to blank_create_form. | none |
| `blank_get_embed_code` | Get the HTML embed snippet (and public URL) for a published form, suitable for pasting into an external page. | `id` |
| `blank_get_form` | Get a form definition with all its fields. | `id` |
| `blank_get_form_analytics` | Get response aggregation data for a form, including per-field breakdowns, submission trends, and summary statistics. | `form_id` |
| `blank_get_submission` | Get a specific submission with all response data. | `id` |
| `blank_list_forms` | List available forms for the current organization. Supports filtering by status and project. | `status`, `project_id` |
| `blank_list_submissions` | List submissions for a form. Returns paginated results. | `form_id`, `cursor`, `limit` |
| `blank_publish_form` | Publish a draft form, making it available for submissions. | `id` |
| `blank_reorder_fields` | Bulk reorder the fields of a form by assigning each field a new sort_order. | `form_id`, `fields`, `id`, `sort_order` |
| `blank_summarize_responses` | Get analytics data for a form including response counts, field breakdowns, and trends. Useful for AI summarization of form results. | `form_id` |
| `blank_update_field` | Update a single form field. Provide only the fields you want to change. | `id`, `field_key`, `label`, `field_type`, `placeholder`, `required`, `min_length`, `max_length`, `options`, `scale_min`, `scale_max`, `scale_min_label`, `scale_max_label`, `sort_order`, `page_number`, `column_span`, `default_value` |
| `blank_update_form` | Update form metadata or settings. | `id`, `form_type`, `accept_responses`, `theme_color` |
