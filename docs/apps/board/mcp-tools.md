# board MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `board_add_collaborator` | Add a collaborator to a board with a view or edit permission. `board_id` accepts a UUID or board name; `user_id` accepts a user UUID or email address. | `board_id`, `user_id`, `permission` |
| `board_add_sticky` | Add a sticky note to a board. `board_id` accepts either a UUID or a board name. | `board_id`, `text`, `x`, `y`, `color` |
| `board_add_text` | Add a text element to a board. `board_id` accepts either a UUID or a board name. | `board_id`, `text`, `x`, `y` |
| `board_archive` | Archive a board (soft delete). `id` accepts either a UUID or a board name. | `id` |
| `board_check_integrity` | Run a per-board integrity check, returning the list of structural issues (e.g. a project_id referencing a project outside the org). `id` accepts either a UUID or a board name. | `id` |
| `board_create` | Create a new visual collaboration board. `template_id` accepts either a UUID or a template name (case-insensitive). | `project_id`, `template_id`, `background`, `visibility` |
| `board_create_template` | Create a board template, optionally seeded from an existing board's scene. `board_id` (if provided) accepts a UUID or a board name to capture as the template. | `category`, `icon`, `board_id` |
| `board_create_version` | Capture a named snapshot of a board's current scene that can later be restored. `board_id` accepts either a UUID or a board name. | `board_id` |
| `board_delete_link` | Delete a single element-to-task link by its link UUID (get it from board_list_links). This does not delete the underlying task or element, only the association. | `link_id` |
| `board_delete_permanent` | Permanently hard-delete a board and ALL of its elements, collaborators, stars, and versions (cascade). This is irreversible — distinct from board_archive which only soft-deletes. `id` accepts either a UUID or a board name. | `id` |
| `board_delete_template` | Delete a board template. `id` accepts either a UUID or a template name. | `id` |
| `board_duplicate` | Duplicate a board, copying its elements into a new board. `id` accepts either a UUID or a board name. | `id` |
| `board_export` | Export a board as SVG or PNG. `id` accepts either a UUID or a board name. | `id`, `format` |
| `board_get` | Get board metadata by ID. | `id` |
| `board_instantiate_template` | Create a new board from a template. `id` accepts a template UUID or name; `project_id` (if provided) accepts a project UUID or name to associate the new board with. | `id`, `project_id` |
| `board_list` | List boards with optional filters and pagination. | `project_id`, `visibility`, `cursor`, `limit` |
| `board_list_collaborators` | List the collaborators (and their view/edit permission) on a board. `id` accepts either a UUID or a board name. | `id` |
| `board_list_links` | List the element-to-Bam-task links on a board (created when stickies are promoted to tasks). `id` accepts either a UUID or a board name. | `id` |
| `board_list_recent` | List the boards most recently updated by or visible to the caller. | none |
| `board_list_starred` | List the boards the calling user has starred. | none |
| `board_list_templates` | List the board templates available to the org (system + org-defined), optionally filtered by category. | `category` |
| `board_list_versions` | List the saved version snapshots of a board. `id` accepts either a UUID or a board name. | `id` |
| `board_org_stats` | Get org-level board statistics (counts, activity rollups across all boards in the organization). | none |
| `board_post_chat` | Post a chat message into a board's side-channel chat. `board_id` accepts either a UUID or a board name. | `board_id`, `body` |
| `board_promote_to_tasks` | Promote sticky notes to Bam tasks in a project. `board_id` accepts either a UUID or a board name. `project_id` accepts either a UUID or a project name. `phase_id` accepts either a UUID or a phase name (scoped to the resolved project). | `board_id`, `element_ids`, `project_id`, `phase_id` |
| `board_read_chat` | Read the recent chat messages on a board (most recent first, capped server-side). `id` accepts either a UUID or a board name. | `id` |
| `board_read_elements` | Read all elements on a board. Returns structured data with positions, text, and types. `id` accepts either a UUID or a board name. | `id` |
| `board_read_frames` | Read frames with their contained elements from a board. | `id` |
| `board_read_stickies` | Read only sticky note elements from a board. | `id` |
| `board_remediate_integrity` | Apply a fix for a board integrity issue: "detach" clears the board's project association, "reassign" moves it to a different project (which must belong to the caller's org). `id` accepts a board UUID or name; for "reassign", `project_id` accepts a project UUID or project name. | `id`, `action`, `project_id` |
| `board_remove_collaborator` | Remove a collaborator from a board. `collaborator_id` is the collaborator-row UUID (get it from board_list_collaborators). | `collaborator_id` |
| `board_restore` | Restore a previously archived board. `id` accepts either a UUID or a board name. | `id` |
| `board_restore_version` | Restore a board to a previously captured version snapshot, replacing its current scene. `board_id` accepts a UUID or board name; `version_id` is the version UUID (get it from board_list_versions). | `board_id`, `version_id` |
| `board_search` | Search across board element text content. | `query`, `project_id` |
| `board_star_toggle` | Toggle the calling user's star on a board (favorite / unfavorite). `id` accepts either a UUID or a board name. | `id` |
| `board_stats` | Get statistics for a single board (element counts, collaborator counts, last activity). `id` accepts either a UUID or a board name. | `id` |
| `board_summarize` | Get a board summary grouped by frames, including element counts and text content. `id` accepts either a UUID or a board name. | `id` |
| `board_update` | Update board metadata. Provide only the fields to change. `id` accepts either a UUID or a board name. | `id`, `background`, `visibility`, `locked`, `icon` |
| `board_update_collaborator` | Change a collaborator's permission (view or edit) on a board. `collaborator_id` is the collaborator-row UUID (get it from board_list_collaborators). | `collaborator_id`, `permission` |
| `board_update_template` | Update a board template's metadata. `id` accepts either a UUID or a template name. Provide only the fields to change. | `id`, `category`, `icon`, `sort_order` |
