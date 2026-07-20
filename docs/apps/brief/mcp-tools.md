# brief MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `brief_append_content` | Append Markdown content to the end of a Brief document. | `id`, `content` |
| `brief_archive` | Archive a Brief document (soft-delete). | `id` |
| `brief_collaborator_add` | Add a user as a collaborator on a Brief document with a given permission level. | `document_id`, `user_id`, `permission` |
| `brief_collaborator_remove` | Remove a collaborator from a Brief document. Get the collaborator ID from brief_collaborators_list. | `collaborator_id` |
| `brief_collaborator_update` | Update an existing collaborator's permission level on a Brief document. Get the collaborator ID from brief_collaborators_list. | `collaborator_id`, `permission` |
| `brief_collaborators_list` | List the per-user collaborators (and their permissions) on a Brief document. | `document_id` |
| `brief_comment_add` | Add a comment to a Brief document, optionally as a reply or anchored to specific text. | `document_id`, `body`, `parent_id`, `anchor_text` |
| `brief_comment_delete` | Delete a Brief comment. The author may delete their own comment; org admins/owners may delete any comment. | `comment_id` |
| `brief_comment_edit` | Edit the body of an existing Brief comment. | `comment_id`, `body` |
| `brief_comment_list` | List comments on a Brief document. | `document_id` |
| `brief_comment_react` | Add an emoji reaction to a Brief comment. | `comment_id`, `emoji` |
| `brief_comment_resolve` | Toggle the resolved state of a comment. | `comment_id` |
| `brief_comment_unreact` | Remove the calling user's emoji reaction from a Brief comment. | `comment_id`, `emoji` |
| `brief_create` | Create a new Brief document. | `title`, `project_id`, `folder_id`, `template_id`, `content`, `visibility` |
| `brief_duplicate` | Duplicate a Brief document, optionally into a different project. | `id`, `project_id` |
| `brief_embed_delete` | Delete an embed (uploaded file/image) record from a Brief document. Get the embed ID from brief_embeds_list. | `embed_id` |
| `brief_embeds_list` | List the embedded files/images recorded on a Brief document. | `document_id` |
| `brief_export_html` | Export a Brief document as a standalone styled HTML page. | `id` |
| `brief_export_markdown` | Export a Brief document as Markdown text. | `id` |
| `brief_folder_create` | Create a Brief folder, optionally nested under a parent folder and/or scoped to a project. | `project_id`, `parent_id`, `sort_order` |
| `brief_folder_delete` | Delete a Brief folder. | `id` |
| `brief_folder_update` | Update or move a Brief folder. Provide only the fields to change. | `id`, `parent_id`, `sort_order` |
| `brief_folders_list` | List the Brief folder tree for the org, optionally scoped to a project. | `project_id` |
| `brief_get` | Retrieve a single Brief document by ID or slug. | `id` |
| `brief_link_beacon` | Link a Brief document to a Beacon knowledge article. | `document_id`, `beacon_id`, `link_type` |
| `brief_link_remove` | Remove a link (task or Beacon) from a Brief document. Get the link ID from brief_links_list. | `document_id`, `link_id` |
| `brief_link_task` | Link a Brief document to a Bam task. | `document_id`, `task_id`, `link_type` |
| `brief_links_list` | List all task and Beacon links attached to a Brief document. | `document_id` |
| `brief_list` | List Brief documents with optional filters and pagination. | `project_id`, `folder_id`, `status`, `created_by`, `cursor`, `limit` |
| `brief_promote_to_beacon` | Graduate a Brief document to a Beacon knowledge article. | `id` |
| `brief_recent` | List recently updated Brief documents the caller can see. | `limit` |
| `brief_restore` | Restore an archived Brief document. | `id` |
| `brief_search` | Search Brief documents by keyword or semantic similarity. | `query`, `project_id`, `status`, `semantic`, `limit` |
| `brief_semantic_search` | Semantic (vector) search over Brief documents. Falls back to full-text search when the vector index is unavailable. | `q`, `limit` |
| `brief_star` | Toggle the calling user's star on a Brief document. | `id` |
| `brief_starred` | List the calling user's starred Brief documents. | none |
| `brief_stats` | Get org-wide Brief document statistics (counts by status, totals, etc.). | none |
| `brief_template_create` | Create an organization-level Brief document template. | `icon`, `category`, `html_preview`, `sort_order` |
| `brief_template_delete` | Delete an organization Brief document template. | `id` |
| `brief_template_update` | Update an organization Brief document template. Provide only the fields to change. | `id`, `icon`, `category`, `html_preview`, `sort_order` |
| `brief_templates_list` | List the available Brief document templates (system + org). | none |
| `brief_update` | Update Brief document metadata. Provide only the fields to change. | `id`, `title`, `status`, `visibility`, `folder_id`, `icon`, `pinned` |
| `brief_update_content` | Replace the entire content of a Brief document with new Markdown. | `id`, `content` |
| `brief_version_create` | Create a named version snapshot of a Brief document at its current state. | `document_id`, `title`, `change_summary` |
| `brief_version_diff` | Compute a line-by-line diff between two versions of a Brief document. | `document_id`, `version_id_1`, `version_id_2` |
| `brief_version_get` | Get a specific version of a Brief document. | `document_id`, `version_id` |
| `brief_version_restore` | Restore a Brief document to a specific previous version. | `document_id`, `version_id` |
| `brief_versions` | List the version history of a Brief document. | `document_id` |
