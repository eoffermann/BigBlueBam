# banter MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `banter_add_channel_members` | Add one or more members to a Banter channel. Accepts a channel UUID, name, or #name, and each user may be a UUID, email, or @handle — mixed lists are supported. | `channel_id`, `user_ids` |
| `banter_add_group_members` | Add members to a user group | `group_id`, `user_ids` |
| `banter_archive_channel` | Archive a Banter channel (reversible). Accepts a channel UUID, a bare channel name, or #name — no need to resolve the id first. | `channel_id` |
| `banter_browse_channels` | Browse available Banter channels (including unjoined public channels) | `q`, `cursor`, `limit` |
| `banter_cancel_scheduled_message` | Cancel a pending scheduled Banter post. Only the original author or an org owner/admin may cancel, and only while the post is still pending (fails 409 otherwise). | `scheduled_message_id` |
| `banter_create_bookmark` | Bookmark a Banter message for the calling user, with an optional note. Idempotent — bookmarking an already-bookmarked message is a no-op. | `message_id`, `note` |
| `banter_create_channel` | Create a new Banter channel | `topic`, `is_private`, `group_id` |
| `banter_create_user_group` | Create a new user group (e.g. @backend-team) | `handle`, `user_ids` |
| `banter_delete_bookmark` | Remove a Banter bookmark for the calling user. Pass either the bookmark id (bookmark_id) or the bookmarked message id (message_id) — exactly one is required. | `bookmark_id`, `message_id` |
| `banter_delete_channel` | Delete a Banter channel (destructive - requires confirmation) | `channel_id`, `confirm_action` |
| `banter_delete_message` | Delete a Banter message (destructive - requires confirmation) | `message_id`, `confirm` |
| `banter_delete_user_group` | Delete a Banter user group (destructive - requires confirmation). Accepts a group UUID or @handle. Requires org owner/admin privileges. | `group_id`, `confirm` |
| `banter_edit_message` | Edit an existing Banter message | `message_id`, `content` |
| `banter_end_call` | End an active call (destructive - requires confirmation) | `call_id`, `confirm` |
| `banter_feed_dismiss` | Dismiss a single feed entry — it is excluded from future reads entirely. | none |
| `banter_feed_explain` | Return the full score breakdown for one feed entry (recency, weight, affinity, interaction, engagement, multipliers). For tuning and debugging. | none |
| `banter_feed_mark_seen` | Mark feed entries as seen (they sink in the ranking but do not vanish). Provide either entry_ids or a before_seq watermark. | `entry_ids`, `before_seq` |
| `banter_feed_query` | The caller's ranked Banter Feed: posts in followed channels, replies on threads they are in, and cross-app activity that concerns them, most-relevant first. Filter by category/source; set explain=true for score breakdowns. | `cursor`, `limit`, `category`, `source`, `unseen`, `explain` |
| `banter_feed_subscription_list` | List the caller's explicit feed subscription rows (the deviations from the default-on state). | none |
| `banter_feed_subscription_set` | Follow / unfollow / mute a scope in the caller's feed. scope_type is item\|channel\|project\|source; scope_source is the app (banter, bam, brief, ...). state is following\|unfollowed\|muted. unfollowed is a soft opt-out (keeps direct items); muted is a hard opt-out. | `scope_type`, `scope_source`, `scope_id`, `state` |
| `banter_feed_weights_get` | Effective feed ranking weights for the caller's org (merged platform defaults + org overrides), plus the raw overrides at each level. | none |
| `banter_feed_weights_set_org` | Set this org's feed ranking weight overrides (org admin/owner). Send only the knobs to override (categories map, gravity, recency_offset, engagement_weight, interaction_boost, affinity_boost, seen_multiplier, candidate_window_days, must_see_floor); the rest inherit. Bumps the version so the change is live on the next read. Platform-level defaults are not agent-editable. | none |
| `banter_find_user_by_email` | Find a Banter user by email (case-insensitive exact match). Returns {id, email, name, display_name, avatar_url} or null if no match. | `email` |
| `banter_find_user_by_handle` | Find a Banter user by handle (accepts "@alice" or "alice"). Banter users do not have a dedicated handle column — matching falls back to a slugified form of display_name (lower-cased, whitespace collapsed to hyphens). Returns the user or null. | `handle` |
| `banter_get_active_huddle` | Check if a channel has an active huddle and get its details | `channel_id` |
| `banter_get_call` | Get details about a specific call | `call_id` |
| `banter_get_channel` | Get detailed information about a Banter channel | `channel_id` |
| `banter_get_channel_by_name` | Resolve a Banter channel by name or handle. Accepts "general", "#general", or a slug. Returns the channel {id, name, handle, type, description} or null if not found. | `name_or_handle` |
| `banter_get_message` | Get a specific Banter message by ID | `message_id` |
| `banter_get_preferences` | Get the authenticated user's Banter notification and theme preferences. | none |
| `banter_get_presence` | Get the authenticated caller's current Banter presence row (status, custom status text/emoji, in-call channel). | none |
| `banter_get_transcript` | Get the transcript for a call | `call_id` |
| `banter_get_unread` | Get the current user's unread message summary across all Banter channels | none |
| `banter_get_user_group_by_handle` | Resolve a Banter user group by handle (accepts "@engineering" or "engineering"). Returns {id, name, handle, description, member_count} or null if no match. | `handle` |
| `banter_invite_agent_to_call` | Invite an AI agent to join an active call as a participant | `call_id`, `agent_id` |
| `banter_join_call` | Join an active call | `call_id` |
| `banter_join_channel` | Join a Banter channel. Accepts a channel UUID, a bare channel name, or #name. | `channel_id` |
| `banter_leave_call` | Leave an active call | `call_id` |
| `banter_leave_channel` | Leave a Banter channel | `channel_id` |
| `banter_list_bookmarks` | List the authenticated caller's Banter message bookmarks, newest first, with channel and message preview context. | none |
| `banter_list_call_participants` | List the participants of a Banter call (historical roster with join/leave times, duration, media flags, and bot/participation-mode metadata). | `call_id` |
| `banter_list_calls` | List calls in a Banter channel (active and recent) | `channel_id`, `status`, `cursor`, `limit` |
| `banter_list_channel_members` | List the members of a Banter channel (with display name, email, role, and mute state). Accepts a channel UUID, a bare channel name, or #name. | `channel_id` |
| `banter_list_channel_presence` | List the non-offline (online/idle/in-call/dnd) members of a Banter channel. Accepts a channel UUID, name, or #name. Presence is ephemeral (Redis-backed) so treat the result as a point-in-time snapshot. | `channel_id` |
| `banter_list_channels` | List all Banter channels the current user has access to | `cursor`, `limit` |
| `banter_list_dms` | List the authenticated caller's direct-message and group-DM channels, ordered by most recent activity. | none |
| `banter_list_group_members` | List the members of a Banter user group. Accepts a group UUID or a group @handle (e.g. "@engineering"). | `group_id` |
| `banter_list_messages` | List messages in a Banter channel with pagination | `channel_id`, `cursor`, `limit`, `direction` |
| `banter_list_pins` | List the pinned messages in a Banter channel (with the pinned message and its author). Accepts a channel UUID, name, or #name. | `channel_id` |
| `banter_list_reactions` | List the emoji reactions on a Banter message, grouped by emoji with the reacting users. | `message_id` |
| `banter_list_scheduled_messages` | List scheduled (or delivered/cancelled/failed) posts queued for a Banter channel. Accepts a channel UUID, name, or #name. Defaults to status="pending". | `channel_id`, `status`, `limit` |
| `banter_list_subscriptions` | List the caller's active pattern subscriptions. Pass channel_id to restrict to a single channel. Returns up to 200 rows ordered by created_at desc. | `channel_id` |
| `banter_list_thread_replies` | List replies in a Banter message thread | `message_id`, `cursor`, `limit` |
| `banter_list_user_groups` | List all user groups in the organization | `cursor`, `limit` |
| `banter_list_users` | Fuzzy search Banter users by name, display name, or email. Returns up to 20 users in the active org ordered by relevance. If no query is supplied, returns the 20 most recently created users. | `query` |
| `banter_mark_read` | Mark a Banter channel read up to a given message — advances the caller's last-read cursor and clears any unified notifications for that channel. Accepts a channel UUID, name, or #name. | `channel_id`, `message_id` |
| `banter_pin_message` | Pin a message in a Banter channel. Accepts a channel UUID, name, or #name. | `channel_id`, `message_id` |
| `banter_post_call_text` | Post a text message in a call channel with a call reference (for text-mode AI participation) | `channel_id`, `call_id`, `content` |
| `banter_post_message` | Post a new message to a Banter channel. Accepts a channel UUID, a bare channel name, or #name. §13 Wave 4: optionally accepts scheduled_at (ISO-8601, max 30 days out), defer_if_quiet (convert to scheduled if channel is in quiet hours), and urgency_override (bypass quiet hours when both caller and channel policy consent). When a post is scheduled or deferred, the tool returns a scheduled envelope ({ scheduled: true, scheduled_message_id, scheduled_at, defer_reason }) instead of an immediate message. | `channel_id`, `content`, `attachment_ids`, `scheduled_at`, `defer_if_quiet`, `urgency_override` |
| `banter_react` | Add or remove an emoji reaction on a Banter message | `message_id`, `emoji` |
| `banter_remove_channel_member` | Remove a member from a Banter channel | `channel_id`, `user_id` |
| `banter_remove_group_member` | Remove a member from a user group | `group_id`, `user_id` |
| `banter_reply_to_thread` | Post a reply in a Banter message thread | `message_id`, `content`, `also_send_to_channel` |
| `banter_schedule_post` | Schedule a Banter post for future delivery. Thin wrapper over banter_post_message with scheduled_at REQUIRED. Returns the scheduled envelope { scheduled: true, scheduled_message_id, scheduled_at, defer_reason }. If respect_quiet_hours is true (default) the scheduled_at is honored as-is; if the channel is in quiet hours at fire time, the worker still delivers because scheduled posts are explicit. Use defer_if_quiet on banter_post_message to instead reschedule around a quiet-hours window at request time. | `channel_id`, `content`, `scheduled_at`, `attachment_ids`, `respect_quiet_hours` |
| `banter_search_channels` | Full-text search Banter channels by name, display name, topic, or description in the caller's org. Returns visible (public or member) channels only. | `q`, `limit`, `offset` |
| `banter_search_messages` | Search messages across Banter channels | `q`, `channel_id`, `from_user_id`, `before`, `after`, `cursor`, `limit` |
| `banter_search_transcripts` | Search call transcripts across Banter (placeholder - returns available transcripts) | `q`, `channel_id`, `cursor`, `limit` |
| `banter_send_dm` | Send a direct message to another user (creates or reuses existing DM channel). Accepts a user UUID, email address, or @handle. | `to_user_id`, `content` |
| `banter_send_group_dm` | Send a group direct message (creates or reuses existing group DM). Each recipient may be a UUID, email, or @handle — mixed lists are supported. | `user_ids`, `content` |
| `banter_set_presence` | Set the authenticated user's presence status in Banter. The status is ephemeral — it auto-expires via a Redis TTL, so callers should not treat it as persistent. | `status`, `status_text`, `status_emoji` |
| `banter_share_sprint` | Share a BigBlueBam sprint summary as a rich embed in a Banter channel. Accepts a channel UUID, name, or #name. | `channel_id`, `sprint_id`, `comment` |
| `banter_share_task` | Share a BigBlueBam task as a rich embed in a Banter channel. Accepts a channel UUID, name, or #name. | `channel_id`, `task_id`, `comment` |
| `banter_share_ticket` | Share a Helpdesk ticket as a rich embed in a Banter channel. Accepts a channel UUID, name, or #name. | `channel_id`, `ticket_id`, `comment` |
| `banter_start_call` | Start a new voice/video call in a Banter channel. Accepts a channel UUID, name, or #name. | `channel_id`, `type` |
| `banter_subscribe_pattern` | Create a passive pattern subscription on a Banter channel. Fires banter.message.matched Bolt events whenever an incoming message matches the supplied pattern_spec. Pattern kinds: 'interrogative' (any question-shaped message), 'keyword' (term list with any/all mode), 'regex' (ADMIN-ONLY to mitigate ReDoS), 'mention' (matches @display_name substrings). Subscriber defaults to the caller, who must be users.kind IN ('agent','service'). Returns subscription_id plus effective=false with a reason string when the channel policy or §15 agent_policies blocks routing - the row is still stored so operators can see the intent. | `channel_id`, `subscriber_user_id`, `pattern`, `rate_limit_per_hour` |
| `banter_unpin_message` | Unpin a message from a Banter channel. Accepts a channel UUID, name, or #name. | `channel_id`, `message_id` |
| `banter_unsubscribe_pattern` | Disable an existing pattern subscription. Idempotent: re-calling on an already-disabled row returns the original disabled_at. Only the subscriber (or a SuperUser) can disable via this path; channel admins wanting to force-unsubscribe an agent should use the channel admin surface. | `subscription_id` |
| `banter_update_channel` | Update a Banter channel name, description, or topic | `channel_id`, `topic` |
| `banter_update_preferences` | Update the authenticated user's Banter notification and theme preferences. | `preferences` |
| `banter_update_user_group` | Update a user group name, handle, or description | `group_id`, `handle` |
