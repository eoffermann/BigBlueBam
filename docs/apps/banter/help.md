# Banter - Team chat for your organization

> Banter is the chat layer of BigBlueBam. It gives your team channels, direct messages, threads, reactions, pins, and bookmarks so conversations live alongside the rest of the suite. Reach for it when work needs a back-and-forth instead of a ticket or a task.

## Overview

Banter is a real-time messaging app shared by everyone in your organization. You talk in **channels** (open rooms anyone can join, or private rooms by invitation), in **direct messages** (one-to-one or small groups), and in **threads** that hang off a single message so a side conversation does not flood the main timeline.

Banter does not have its own login or its own user list. You sign in to BigBlueBam (Bam) first, and Banter uses that same identity and the same people. Everyone you can message is already a member of your org. If you open Banter while signed out, you see "Please log in to BigBlueBam first to access Banter" with a link back to the main app.

Banter is in **BETA**. A "beta" pill appears next to the **Banter** wordmark in the sidebar. Posting, threading, reacting, pinning, bookmarking, mentions, DMs, search, attachments, and scheduled posts driven by automation or AI agents are all working.

Live audio is **not** started from inside Banter. The voice and video write actions were retired; every call write endpoint returns HTTP 410 Gone, and live audio for a channel now happens in the suite-wide Bureau docked box (which joins a shared room derived from the channel). Banter keeps a read-only view of past calls and their transcripts, but you do not start or join a call from inside Banter. See "Past calls and audio" below.

### Key concepts

- **Channel** - a named conversation space. Channels are `public` (anyone in the org can find and join), `private` (invite only), or a DM type (`dm` / `group_dm`). Each channel has a name, an optional topic and description, members with roles, and a slug that is unique within your org.
- **#general** - the default channel. The first time anyone opens Banter in an org that has no channels, Banter creates `#general`, marks it the default, and auto-joins every active member (the creator becomes owner). You cannot delete or leave the default channel.
- **Channel role** - your standing inside one channel: `owner`, `admin`, `member`, or `viewer`. A **viewer** is read-only and cannot post. Channel admins manage pins, members, and settings.
- **Direct message (DM)** - a private conversation with one other person. A **group DM** is a private conversation with 3 to 8 people total.
- **Message** - a single post. Messages support rich text (bold, italic, code, links), @mentions, and emoji, up to 40,000 characters. You can edit or delete your own messages.
- **Thread** - replies attached to a parent message. A reply stays in the thread unless you tick **Also send to channel**, which also mirrors it into the main timeline.
- **Reaction** - an emoji you toggle on a message. Click once to add, click again to remove.
- **Pin** - a channel-wide marker that any member can see in the channel's pinned list. Only channel admins can pin or unpin.
- **Bookmark** - your own private save of a message, with an optional note. Bookmarks are visible only to you and live on the Bookmarks page.
- **Mention** - typing `@` plus a name notifies that person. Org admins can also define @mention user groups (for example `@engineering`) that notify everyone in the group.
- **Presence** - your live status: online, idle, in a call, do not disturb, or offline.
- **Scheduled message** - a message queued to post later at a set time, or deferred automatically when a channel is inside its quiet hours.
- **Quiet hours** - a per-channel policy that holds non-urgent posts until the channel's allowed hours. Used mostly by automated and agent posts.
- **Agent pattern subscription** - a rule that lets an agent or service account listen to a channel and react when messages match a pattern.

### Where to find it

Banter is served at `/banter/`. Reach it from the Launchpad app switcher in the top-left of any BigBlueBam app. The default landing channel is `#general` (`/banter/channels/general`); a bare `/banter/` visit redirects there.

Prerequisites:

- You must be signed in to BigBlueBam. Banter has no separate login.
- You must belong to an organization. Everyone you can message is a member of that org.
- To create channels, your org's policy must allow it for your role (set under **Banter Administration**).
- To manage org settings, channel groups, @mention groups, or a Slack import, you need org admin or owner access.

![Channels & sidebar](screenshots/light/02-channel-list.png)

## Feature reference

### Send a message

The compose box sits at the bottom of every channel and DM.

To post a message:

1. Open a channel from the sidebar or a DM from the **Direct Messages** section.
2. Click the text box that reads `Message #<channel>` and type.
3. Use the toolbar above the box for formatting: **Bold**, **Italic**, **Code**, **Link**, **Attach file**, and **Emoji**. The emoji picker offers a palette of 24 common emoji.
4. Type `@` to mention someone; pick a name from the autocomplete list.
5. Press **Enter** to send. Use **Shift+Enter** for a new line. The hint under the box reads "Enter to send, Shift+Enter for newline".

Your draft is saved per channel, so switching channels does not lose what you were typing.

To attach a file: click **Attach file**, pick one or more files, and they upload to storage. While the upload runs you see "Uploading...". Once a file is selected, the box shows "N files attached" with each filename and a **Remove all** link. The file is linked to the message when you send it, so the recipients see the attachment in the channel. You can send a message that is only an attachment with no text.

![Channel conversation](screenshots/light/01-channel-view.png)

### Reply in a thread

Threads keep a focused discussion attached to one message.

To reply in a thread:

1. Hover over the message you want to reply to.
2. In the hover bar, click **Reply in thread**. The right-hand **Thread** panel opens.
3. Type your reply in the box labeled "Reply...".
4. To also post your reply into the main channel timeline, tick **Also send to channel** before sending.
5. Press **Enter** or click the send button.

The parent message shows a "N reply" / "N replies" link that reopens the thread. Replying notifies the parent author and prior repliers.

![Threaded replies](screenshots/light/03-thread.png)

### React to a message

To add or remove a reaction:

1. Hover over a message and click **Add reaction**.
2. Choose an emoji. The quick reactions are thumbs up, heart, laughing, party, eyes, and rocket.
3. Click the same emoji badge again to remove your reaction.

Reaction badges under a message show the emoji and a running count.

### Pin a message

Pins are channel-wide and visible to every member. Only channel admins can pin.

To pin or unpin:

1. Hover over the message and click **Pin message** (or open the more menu and choose **Pin to channel**).
2. To remove it, hover and click **Unpin message** (or **Unpin from channel** in the more menu).
3. View the channel's pins with the **Pinned messages** button in the channel header.

If you are not a channel admin, pinning fails with "Couldn't pin - channel admins only".

### Bookmark a message

Bookmarks are private to you, with an optional note.

To bookmark:

1. Hover over a message and click **Bookmark** (or choose **Bookmark** in the more menu).
2. To remove it, click **Remove bookmark**.
3. Open all your saved messages from the **Bookmarks** quick action in the sidebar.

On the **Bookmarks** page each row links to the channel and shows the author and a preview. Use **Go to message** to jump there or **Remove bookmark** to clear it. When empty, the page reads "No bookmarks yet".

### Edit or delete your message

To edit:

1. Hover over your own message and open the more menu.
2. Click **Edit message**, change the text, and click **Save** (or press Enter). Click **Cancel** or press Esc to discard.

Edited messages show "(edited)". A message may be locked by its author or thread starter; a lock icon and the note "This message is locked - nobody may edit it." indicate you cannot edit it. Org admins and owners can always edit.

To delete:

1. Open the more menu on your own message.
2. Click **Delete message**.

Deletes are soft (the message is removed from view). Channel and org admins can delete others' messages.

### Create a channel

To create a single channel:

1. In the sidebar, find the **Channels** section and click the **+** button.
2. In the inline **New Channel** box, type a name in the `channel-name` field (lowercase letters, numbers, and hyphens, up to 80 characters).
3. Click **Create**. You are taken to the new channel.

Whether you can create channels depends on your org policy ("Who can create channels"). The server enforces that policy on every create: with **Everyone** any member can create, with **Admins only** only org admins and owners can, and with **Organization owners only** only owners can. Channel creation is rate-limited to 5 per hour.

To add many channels at once (org admins):

1. Right-click the **+** button. The tooltip reads "Create channel - right-click to add many".
2. In the **Add many channels** dialog, paste one channel name per line. The dialog notes "Paste one channel name per line. Up to 50 at a time." and summarizes how many are valid, duplicate, or invalid.
3. Choose **Public** or **Private**.
4. Click **Create N channels**. Each row reports back as created, duplicate, invalid, or error. If any rows are left, **Create remaining** continues.

Note: the **Add many channels** dialog uses a coarser permission gate than the single **+** create. It admits any org admin or owner (and any member when your org's policy allows members to create channels) but does not apply the **Organization owners only** distinction. If your org is set to owners-only, create those channels one at a time with the **+** button to be sure the policy is honored, or have an owner run the bulk dialog.

### Browse and join channels

To find and join open channels:

1. Click **Browse channels** in the sidebar. The **Browse Channels** page opens.
2. Type in the `Search channels...` box to filter.
3. Each result shows the channel name, a **Private** pill if applicable, the topic, the member count ("N members"), and when it was last active ("Last active ...").
4. Click **Join** on a channel you want. Channels you already belong to show **Joined**.

When nothing matches you see "No channels found" and "Try a different search term". Joining is only allowed on public channels; private channels require an invitation.

### Start a direct message or group DM

To start a one-to-one DM:

1. In the sidebar, open the **Direct Messages** section.
2. Click a team member listed there. A DM opens (or reuses an existing one).

A group DM holds 3 to 8 people total and must be allowed by your org's group-DM setting. If the people list fails to load, the sidebar shows "Couldn't load people - tap to retry"; with no teammates it shows "No team members found".

![Direct messages](screenshots/light/04-dms.png)

### Configure a channel

Channel admins manage a channel from its settings.

To change channel settings:

1. In the channel header, click the **Channel settings** button (gear icon). The **Channel Settings** modal opens.
2. Edit **Channel name**, **Topic**, or **Description**.
3. Toggle **Allow bots** and **Allow huddles** as needed.
4. Click **Save Changes**. A "Saved!" confirmation appears.
5. Under **Members (N)**, review the member list.

To add a member from this modal, type an email or username into the **Email or username** field and click **Add**. The server resolves the identifier to a person in your org (exact email first, then a handle built from the display name) and adds them. If no active member matches, you get a "No active user in this organization matches ..." error.

To archive (delete) a channel:

1. Open the channel's **Channel Settings** modal, or use the per-channel hover menu in the sidebar.
2. In the **Danger Zone** (shown only for non-default channels), click **Delete Channel**.
3. Confirm at the prompt "Are you sure you want to delete #<name>? This will archive the channel and all its messages. This action cannot be undone." by clicking **Yes, delete channel**.

Deleting a channel archives it; it disappears from the active list. The default channel cannot be deleted or left.

### Rename, leave, or delete from the sidebar

Hover a channel in the sidebar to reveal its menu:

- **Rename** - rename in place.
- **Channel settings** - open the settings modal.
- **Leave channel** - leave (hidden for the default channel). The last remaining owner cannot leave while other members stay; you see "LAST_OWNER_CANNOT_LEAVE" if you try.
- **Delete channel** - archive it; click again at "Click again to confirm".

### Mark a channel read

Banter tracks your read position automatically. Opening a channel clears its unread badge, and your read cursor syncs across devices, so a channel you read on your laptop is not flagged unread on your phone. Unread channels show a dot, and channels with unread mentions show a count badge. The read cursor is also broadcast (`channel.read_cursor_synced`) so open tabs update live.

### Search messages

The **Search** page (reached from the header search box or the sidebar) has a query box (`Search messages...`) and **Filters** for **Channel** (`All channels`), **Author** (`Anyone`), **From date**, **To date**, and **Has attachments**. Use **Clear all filters** to reset.

To search:

1. Open Search from the header search box or the sidebar.
2. Type at least two characters in the `Search messages...` box and press Enter.
3. Optionally click **Filters** and narrow by **Channel**, **Author**, **From date**, **To date**, or **Has attachments**.
4. Read the result rows; each shows the channel, author, time, and a snippet with the matched terms highlighted. Click a row to jump to that channel.

When nothing matches you see "No results found" and "Try different keywords". Search runs Postgres full-text search over message text and is scoped to channels you can see.

The same search is available to AI agents through the MCP tool `banter_search_messages`, and there are companion endpoints for channel search (`GET /v1/search/channels`) and call-transcript search (`GET /v1/search/transcripts`).

![Message search](screenshots/light/05-search.png)

### Past calls and audio

Banter no longer hosts the live call experience. Live audio for a channel happens in the suite-wide **Bureau** docked box, which joins a shared room derived from the channel (`huddle-banter-<channel_id>`), not inside Banter. There is no "start call" button in a Banter channel, and every call write endpoint in the API returns HTTP 410 Gone with `X-Deprecated-Replacement: bureau-docked-box`. The matching MCP write call tools target those retired endpoints and will fail if invoked.

What remains in Banter is read-only history:

1. Open a past call's playback page at `/banter/calls/:id`.
2. Review its type (voice, video, or huddle), duration, participants, and transcript.

Do not expect to start, join, or end a call from Banter. For live audio, use the Bureau docked box.

### Keyboard shortcuts

- **Ctrl/Cmd+K** - quick channel switcher.
- **Ctrl/Cmd+Shift+M** - toggle mute on the current channel.
- **Esc** - close the open thread or the channel switcher.
- **?** - open Help.
- **Up arrow** in an empty compose box - edit your last message.

### Preferences

Open the **Preferences** page from the user menu. Sections include **Profile**, **Theme** (`Light`, `Dark`, `System`), **Notifications** (`Desktop notifications`, `Notification sound`), and **Messaging** (`Enter to send`, `Show typing indicators`, `Compact mode`). Click **Save Preferences** to apply.

Your theme choice (`Light`, `Dark`, `System`) is saved locally in your browser (`bbam-theme`). The five other toggles - **Notification sound**, **Desktop notifications**, **Enter to send**, **Show typing indicators**, and **Compact mode** - are stored on the server, so they round-trip and follow you across devices.

![Preferences](screenshots/light/06-preferences.png)

### Admin: organization policy

Org admins open **Banter Administration** from the Admin link.

To set org-wide policy:

1. Go to **Banter Administration**.
2. Under **Channel Settings**, set **Who can create channels** (`Everyone`, `Admins only`, or `Organization owners only`) and the **Default Channel**.
3. Under **Message Settings**, set message retention days and the maximum file size.
4. The **Voice & Video** section and the Voice Agent / STT / TTS / LLM block configure the external audio integration used by the Bureau audio layer (LiveKit host/key/secret, plus STT, TTS, and LLM providers). Set these only if you run that integration. **Test Connection** validates LiveKit credentials.
5. Save your changes.

All three **Who can create channels** options take effect: **Everyone** lets any member create channels, **Admins only** limits it to org admins and owners, and **Organization owners only** limits it to owners. The single **+** create in the sidebar enforces whichever you choose. (The bulk **Add many channels** dialog applies a coarser admin-or-owner gate; see "Create a channel".)

### Admin: organize the sidebar with channel groups

Channel groups are sidebar buckets that group related channels.

To manage groups:

1. As an org admin, open the channel-groups admin area.
2. Create a group with a name, reorder groups, edit, or delete them.

Channel groups carry a name, a position, and a default collapsed state, and can optionally be tied to a project.

### Admin: define @mention groups

User groups let you mention a whole team at once, for example `@engineering`.

To create one:

1. As an org admin, open the user-groups admin area.
2. Create a group with a **name**, a **handle** (the @mention text), and an optional description.
3. Add members to the group.

Mentioning the group's handle in a message notifies every member.

### Admin: import from Slack

Org admins can migrate a Slack workspace export.

To run an import:

1. Open the Slack import area under admin.
2. Upload your Slack export `.zip`. Banter parses it and shows a preview of users and channels.
3. Map each user (`auto_match`, `send_invite`, create a `stub`, `map_existing` to an existing user, or `skip`) and each channel (`import_new`, `merge_existing`, or `skip`).
4. Choose options such as preserving timestamps and whether to bring over attachments, reactions, pins, and DMs. A dry-run option is available.
5. Start the import and poll its status until it completes.
6. You can abort an in-progress import and optionally clean up any stub users it created.

### Working with AI agents

Agents and service accounts drive a large share of Banter activity through the MCP tool set: over 50 core Banter tools (54 as of this writing) plus 3 subscription tools. The full catalog is in the Banter MCP-tools reference; the most common flows are below. Channel and user arguments accept a UUID, a bare name or `#name`, or an email or `@handle`, resolved server-side.

- **Post, schedule, DM, react, pin.** Agents post with `banter_post_message` (a channel can be given by `#name`), reply with `banter_reply_to_thread`, react with `banter_react`, pin with `banter_pin_message` and unpin with `banter_unpin_message`, and DM with `banter_send_dm` or `banter_send_group_dm` (each creates-or-reuses the conversation and posts in one call). Edits use `banter_edit_message`. Destructive tools (`banter_delete_channel`, `banter_delete_message`) require an explicit confirm step via the `confirm_action` flow.
- **Scheduled posts and quiet hours.** Use `banter_schedule_post` with a required `scheduled_at` to queue a message for later. If a channel has a quiet-hours policy, a normal post inside the quiet window is held and delivered later (when `defer_if_quiet` is set) or rejected with `QUIET_HOURS`. A worker delivers scheduled and deferred messages at the right time. List pending ones with `banter_list_scheduled_messages` and cancel one with `banter_cancel_scheduled_message`. Banter emits `message.scheduled` and `message.quiet_hours_deferred` events so automations can react.
- **Passive listening (pattern subscriptions).** An agent can subscribe a channel to a pattern with `banter_subscribe_pattern` (kinds: `interrogative`, `keyword`, `regex` which is admin only, and `mention`). Matches fire a `message.matched` event (on source `banter`) that the agent can act on. Manage subscriptions with `banter_unsubscribe_pattern` and `banter_list_subscriptions`. Subscriptions are gated by the channel's `agent_subscription_policy` and by org-level agent policies; a blocked subscription is recorded but marked not effective (`effective:false`) with a reason.
- **Share suite entities.** Agents can drop a Bam task or sprint, or a Helpdesk ticket, into a channel with `banter_share_task`, `banter_share_sprint`, and `banter_share_ticket`.
- **Read and resolve.** `banter_list_messages`, `banter_search_messages`, `banter_search_channels`, `banter_browse_channels`, `banter_list_channel_members`, `banter_get_unread`, `banter_mark_read`, `banter_find_user_by_email`, and `banter_find_user_by_handle` let an agent read context before acting.

These per-app tools sit on top of the cross-cutting agentic platform. Agents identify themselves and prove liveness with `agent_heartbeat`; high-impact actions can be routed through an approval queue with `proposal_create` / `proposal_list` / `proposal_decide`. Cross-app discovery uses `search_everything` and `resolve_references` (canonical mention syntax) rather than per-app search alone, and the unified activity view stitches Banter posts in with the rest of the suite. Every service-account tool call is checked against the org's `agent_policies` (per-agent kill switch plus glob allowlist, for example `banter.*`), and subscribed Bolt events can be pushed to agent runners via signed outbound webhooks.

What a human should know when reviewing agent work: agents posting into shared Banter surfaces honor per-entity visibility (they call `can_access` for each cited entity and drop anything the asker is not allowed to see), and replies route human-in-the-loop follow-ups to the thread author. Scheduled and deferred posts will appear later than the moment the agent ran, which is expected. Banter emits Bolt events on the `banter` source (`channel.created`, `message.posted`, `message.mentioned`, `message.edited`, `reaction.added`, `message.scheduled`, `message.quiet_hours_deferred`, and `message.matched`) that you can wire into automations or audit.

## Working together (live presence)

BigBlueBam treats collaboration as ambient, not as a scheduled meeting. Banter is the suite's real-time room: channels, DMs, and calls or huddles in the same place as the conversation. You can invite an AI agent into a call to listen and help. Voice and video here are the digital version of bumping into a colleague in the hallway or stopping by their desk: a quick question, a shared look at the same thing, then back to work. Your presence travels with you across the suite through the Bureau virtual office. The Introduction covers the full pervasive-presence model.

## User Stories

### Story: Get into Banter and read #general

**Who:** A new team member opening Banter for the first time.
**Goal:** Reach the team's main channel and start reading.
**Before you start:** You are signed in to BigBlueBam and belong to an org.

**Steps**

1. Open the Launchpad app switcher in the top-left and choose Banter.
2. Banter loads at `#general`. If this is the very first visit for your whole org, `#general` is created automatically and everyone is added.
3. Read the timeline. Unread channels in the sidebar show a dot; mentions show a count badge.
4. Open the **Direct Messages** section in the sidebar to see who you can message.

**Result:** You are in `#general`, can see your channels and teammates, and your read position is tracked from here on.

**Related:** Create a channel; Start a direct message.

### Story: Send your first message

**Who:** Any member.
**Goal:** Post a formatted message with a mention to a channel.
**Before you start:** You are a member (not a viewer) of the channel.

**Steps**

1. Open the channel from the sidebar.
2. Click the box that reads `Message #<channel>` and type your text.
3. Select a word and click **Bold** or **Italic** in the toolbar to format it; click **Code** for inline code or **Link** to add a URL.
4. Type `@` and pick a teammate from the autocomplete to mention them.
5. Click **Emoji** to add an emoji from the palette.
6. Press **Enter** to send (use **Shift+Enter** for a new line).

**Result:** Your message appears in the timeline, the mentioned person is notified, and your draft is cleared.

**Related:** React to a message; Reply in a thread; Attach a file. An agent can post the same way with `banter_post_message`.

### Story: Attach a file to a message

**Who:** Any member of the channel.
**Goal:** Share a file alongside a message.
**Before you start:** The file is within your org's maximum file size.

**Steps**

1. Open the channel and click **Attach file** in the compose toolbar.
2. Pick one or more files. While they upload, the box shows "Uploading...".
3. Confirm the "N files attached" preview lists your files. Use **Remove all** to clear them and start over.
4. Type a message if you want one, then press **Enter** to send. An attachment-only message with no text is allowed.

**Result:** The message posts with its attachments, and everyone in the channel can see and open them.

**Related:** Search supports a **Has attachments** filter to find messages with files later.

### Story: Create a channel for a new topic

**Who:** A member whose org allows channel creation, or an org admin.
**Goal:** Stand up a new channel and start posting in it.
**Before you start:** Your org's "Who can create channels" policy permits your role.

**Steps**

1. In the sidebar, click the **+** next to **Channels**.
2. In the **New Channel** box, type a name in the `channel-name` field using lowercase letters, numbers, and hyphens.
3. Click **Create**.
4. You land in the new channel; post your first message to seed the conversation.

**Result:** The channel exists, you own it, and it shows in your sidebar.

**Related:** To create several at once, an org admin can right-click the **+** for **Add many channels** (which uses a coarser admin-or-owner gate). Agents create channels with `banter_create_channel`.

### Story: Find and join an existing channel

**Who:** Any member looking for the right room.
**Goal:** Discover a public channel and join it.
**Before you start:** None.

**Steps**

1. Click **Browse channels** in the sidebar.
2. On the **Browse Channels** page, type in the `Search channels...` box.
3. Scan the results for the right topic and member count.
4. Click **Join** on the channel you want.

**Result:** You are a member; the channel appears in your sidebar and shows **Joined** in the browser.

**Related:** Agents can list public channels with `banter_browse_channels` and join with `banter_join_channel`.

### Story: Start a direct message

**Who:** Any member.
**Goal:** Have a private one-to-one conversation.
**Before you start:** The other person is an active member of your org.

**Steps**

1. Open the **Direct Messages** section in the sidebar.
2. Click the person you want to message.
3. Type in the compose box and press **Enter**.

**Result:** A private DM opens (or an existing one is reused) and your message is delivered.

**Related:** For a small group, an org that allows group DMs can start one with 3 to 8 people. Agents use `banter_send_dm` and `banter_send_group_dm`.

### Story: Hold a side conversation in a thread

**Who:** Any member.
**Goal:** Reply to a specific message without cluttering the channel.
**Before you start:** There is a message you want to respond to.

**Steps**

1. Hover the message and click **Reply in thread**.
2. In the **Thread** panel, type your reply in the "Reply..." box.
3. If the whole channel should see it too, tick **Also send to channel**.
4. Press **Enter** to send.

**Result:** Your reply is attached to the thread, the parent shows an updated reply count, and the parent author and prior repliers are notified.

**Related:** Agents reply with `banter_reply_to_thread`.

### Story: React, pin, and bookmark a message

**Who:** Any member (pinning requires channel admin).
**Goal:** Acknowledge a message, surface it for the channel, and save it for yourself.
**Before you start:** None for reacting or bookmarking; channel admin for pinning.

**Steps**

1. Hover the message and click **Add reaction**, then pick an emoji.
2. If you are a channel admin, click **Pin message** to add it to the channel's pinned list. Open **Pinned messages** in the header to review pins.
3. Click **Bookmark** to save the message privately. Find it later under **Bookmarks** in the sidebar.

**Result:** Your reaction shows under the message, the pin (if you added one) is visible to all members, and the bookmark is saved to your Bookmarks page.

**Related:** Edit or delete your message. Agents use `banter_react`, `banter_pin_message`, `banter_unpin_message`, and `banter_create_bookmark`.

### Story: Edit or delete something you posted

**Who:** The message author (or a channel/org admin for deletion).
**Goal:** Fix a typo or remove a message.
**Before you start:** The message is yours and is not locked.

**Steps**

1. Hover your message and open the more menu.
2. Click **Edit message**, change the text, and click **Save** (or press Enter; press Esc to cancel).
3. To remove it instead, open the more menu and click **Delete message**.

**Result:** Edited messages show "(edited)"; deleted messages disappear from the timeline.

**Related:** Agents use `banter_edit_message` and `banter_delete_message` (delete requires confirmation).

### Story: Find an old message with search

**Who:** Any member.
**Goal:** Locate a past message across the channels you can see.
**Before you start:** You are in Banter.

**Steps**

1. Click the header search box or open **Search** from the sidebar.
2. Type at least two characters of what you remember and press Enter.
3. Click **Filters** and narrow by **Channel**, **Author**, **From date**, **To date**, or **Has attachments** if the results are broad.
4. Click a result row to jump to that message's channel.

**Result:** You see matching messages with the search terms highlighted, scoped to channels you belong to.

**Related:** An agent can run the same search with `banter_search_messages`.

### Story: Configure and tidy a channel

**Who:** A channel admin.
**Goal:** Set a channel's name, topic, and behavior, add a member, and manage its lifecycle.
**Before you start:** You are an admin or owner of the channel.

**Steps**

1. In the channel header, click **Channel settings**.
2. Edit **Channel name**, **Topic**, and **Description**.
3. Toggle **Allow bots** and **Allow huddles** as needed.
4. Click **Save Changes** and confirm the "Saved!" message.
5. To add a member, type an email or username into the **Email or username** field and click **Add**.
6. To archive the channel, open the **Danger Zone**, click **Delete Channel**, and confirm with **Yes, delete channel**.

**Result:** The channel reflects your changes, the new member is added, or the channel is archived and removed from the active list.

**Related:** Agents update channels with `banter_update_channel`, add members with `banter_add_channel_members`, and archive with `banter_archive_channel`.

### Story: Schedule a message for later (automation and agents)

**Who:** A workflow or an AI agent.
**Goal:** Post a message at a specific future time, or respect a channel's quiet hours.
**Before you start:** An agent or automation with permission to post to the channel. There is no in-app scheduler in the SPA today.

**Steps**

1. The agent calls `banter_schedule_post` with the channel, the content, and a future `scheduled_at`.
2. If the channel has a quiet-hours policy and the post lands inside the quiet window, it is deferred automatically when `defer_if_quiet` is set, or rejected with `QUIET_HOURS` otherwise.
3. A worker delivers the message at the scheduled time.
4. Pending scheduled messages for a channel can be listed with `banter_list_scheduled_messages` and cancelled with `banter_cancel_scheduled_message` before they send.

**Result:** The message posts at the right time. Banter emits `message.scheduled` (and `message.quiet_hours_deferred` when deferred) for downstream automations.

**Related:** Pattern subscriptions let an agent listen for matching messages and react.

### Story: Have an agent listen for a pattern and respond

**Who:** An AI agent or service account, plus a channel admin to allow it.
**Goal:** Trigger agent action whenever messages in a channel match a pattern.
**Before you start:** The channel's `agent_subscription_policy` and the org's agent policies allow the agent.

**Steps**

1. The agent subscribes with `banter_subscribe_pattern`, choosing a kind: `interrogative`, `keyword`, `mention`, or `regex` (regex is admin only).
2. When a message matches, Banter fires a `message.matched` event (on source `banter`).
3. The agent acts on the match (for example, replies in the thread, routes to a human, or shares a suite entity), honoring `can_access` on anything it cites.
4. Remove the subscription with `banter_unsubscribe_pattern`; review active ones with `banter_list_subscriptions`.

**Result:** The agent reacts automatically to matching traffic. Blocked subscriptions are recorded as not effective (`effective:false`) with a reason, so you can see why an agent is not listening.

**Related:** Share a suite entity into the channel after a match.

### Story: Share a task, sprint, or ticket into a channel

**Who:** A member or an agent.
**Goal:** Bring a Bam task or sprint, or a Helpdesk ticket, into a conversation.
**Before you start:** You can see the entity you want to share.

**Steps**

1. From an automation or agent, call `banter_share_task`, `banter_share_sprint`, or `banter_share_ticket` with the channel and the entity.
2. The shared entity is posted into the channel for everyone to discuss.

**Result:** The channel shows a reference to the entity, keeping the discussion next to the work.

**Related:** Reply in a thread to discuss the shared item without flooding the channel.

### Story: Set up Banter for the whole org

**Who:** An org admin or owner.
**Goal:** Decide who can create channels, set retention and file limits, and organize the sidebar.
**Before you start:** You have org admin or owner access.

**Steps**

1. Open **Banter Administration**.
2. Under **Channel Settings**, set **Who can create channels** and the **Default Channel**.
3. Under **Message Settings**, set retention days and maximum file size.
4. Create channel groups to bucket channels in the sidebar.
5. Define @mention user groups (for example `@engineering`) and add members.

**Result:** New channels follow your policy, the sidebar is organized, and teams can be mentioned as a group.

**Related:** Migrate an existing Slack workspace with the Slack import. All three "Who can create channels" options are enforced on the single **+** create; the bulk **Add many channels** dialog uses a coarser admin-or-owner gate.

### Story: Migrate a Slack workspace

**Who:** An org admin.
**Goal:** Bring channels, history, and people over from Slack.
**Before you start:** You have a Slack export `.zip` and admin access.

**Steps**

1. Open the Slack import area under admin and upload the `.zip`.
2. Review the preview of users and channels.
3. Map each user (`auto_match`, `send_invite`, `stub`, `map_existing`, or `skip`) and each channel (`import_new`, `merge_existing`, or `skip`).
4. Choose options such as preserving timestamps and importing attachments, reactions, pins, and DMs. Run a dry run first if you want to validate.
5. Start the import and poll its status to completion.

**Result:** Your Slack content is imported into Banter according to your mapping; you can abort and clean up stubs if needed.

**Related:** Channel groups and @mention groups help organize the imported channels and teams.

### Story: Review a past call

**Who:** Any member with access to the channel where the call happened.
**Goal:** Look back at a finished call and read its transcript.
**Before you start:** A call took place; live audio is handled by the Bureau docked box, not Banter.

**Steps**

1. Open the call's playback page at `/banter/calls/:id`.
2. Review the call type (voice, video, or huddle), duration, and participants.
3. Read the transcript.

**Result:** You have a read-only record of the call. You cannot start, join, or end a call from Banter; use the Bureau docked box for live audio.

**Related:** None.

## Related

- **BigBlueBam (Bam)** at `/b3/` - the host app that owns your identity, organizations, and people. You sign in there before using Banter, and tasks and sprints shared into Banter come from Bam.
- **Helpdesk** at `/helpdesk/` - tickets shared into a Banter channel come from here.
- **Bureau docked box** - the suite-wide live-audio layer that replaced Banter calls. Use it for voice and video; Banter keeps only the read-only call history.
- **Bolt** at `/bolt/` - the automation engine that consumes Banter events (`channel.created`, `message.posted`, `message.mentioned`, `message.edited`, `reaction.added`, `message.scheduled`, `message.quiet_hours_deferred`, and `message.matched`, all on source `banter`) and can drive Banter actions.
- **Banter MCP-tools reference** in `docs/apps/banter/` - the full catalog of the Banter tools (over 50 core tools plus the 3 subscription tools) used by AI agents.
- **Banter guide** in `docs/apps/banter/` - product-level overview. Where it advertises live voice calls, follow this help doc instead: those calls are retired in Banter, and live audio is handled by the Bureau docked box.
