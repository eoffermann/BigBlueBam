# Banter - Team Chat

Banter is BigBlueBam's real-time team chat app. It gives your organization channels, direct messages, threads, reactions, pins, and bookmarks so conversations live next to the rest of the suite. You sign in to BigBlueBam first and Banter shares that same identity and the same people, so there is no separate login or user list to manage.

## Key Features

- **Channels** for organized team conversations, public or private, with topics, descriptions, pinned messages, and per-user bookmarks
- **Threaded replies** that keep discussions contextual without cluttering the main channel, with an option to mirror a reply back to the channel timeline
- **Direct messages** for private one-to-one or small group conversations (3 to 8 people in a group DM)
- **Rich text and emoji** with bold, italic, code, links, mentions, and toggleable emoji reactions
- **Search, presence, and read tracking** across channels, with a read cursor that syncs across your devices
- **Scheduled posts and quiet hours** so automations and AI agents can queue messages for later or defer them outside a channel's allowed hours
- **Agent pattern subscriptions** that let agents listen to a channel and react when messages match an interrogative, keyword, mention, or regex pattern

## Integrations

Banter connects to the rest of BigBlueBam. Agents and automations can drop a Bam task or sprint, or a Helpdesk ticket, into a channel as a shareable reference. Bolt automations consume Banter events (`channel.created`, `message.posted`, `message.mentioned`, `message.edited`, `reaction.added`, `message.scheduled`, `message.quiet_hours_deferred`, and `message.matched`, all on source `banter`) and can post back into channels. Over 65 core Banter MCP tools plus 3 subscription tools let AI agents post, reply, react, pin, DM, schedule, search, and subscribe with the same authority as a human, gated by org agent policies, per-entity visibility checks (`can_access`), and an optional approval queue. Live audio for a channel is handled by the suite-wide Bureau docked box, not inside Banter; Banter keeps a read-only history of past calls and their transcripts. Press Ctrl/Cmd+K for the quick channel switcher.

## Getting Started

Open Banter from the Launchpad app switcher. You land in the #general channel by default, which is created and populated automatically the first time your org opens Banter. Browse and join public channels, create new ones for your team or project, start direct messages, and use threaded replies for focused discussions. Press ? for help at any time.

## Working together

Banter carries real-time channels and DMs plus calls and huddles in the same room as the conversation, and an AI agent can be invited into a call.
