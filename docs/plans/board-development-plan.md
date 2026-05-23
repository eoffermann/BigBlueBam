# Board Development Plan

## Overview

Board is an infinite-canvas visual collaboration tool with:
- tldraw-based canvas with real-time CRDT collaboration
- Built-in audio conferencing for collaborators (via LiveKit)
- Side chat feed for text communication while working
- Multitouch support (pinch-zoom, pan, draw)
- Sticky-to-task pipeline (promote stickies to Bam tasks)
- 14 MCP tools for AI canvas interaction
- Cross-product embeds (Bam tasks, Beacon articles, Bearing goals)
- 10 system templates (retro, brainstorm, architecture, etc.)

## Architecture Decisions

### Collaboration: tldraw sync + Yjs
- Use tldraw's native sync capabilities with Yjs backend
- Hocuspocus WebSocket server on port 4008 (same pattern as Brief)
- Yjs state persisted to PostgreSQL (boards.yjs_state)
- Awareness protocol for cursor/viewport tracking

### Audio Conferencing: LiveKit
- Auto-join a LiveKit room when opening a board
- Room name = board ID (unique per board)
- Mute by default, unmute to talk
- Uses existing LiveKit infrastructure (already in docker-compose)
- Frontend: @livekit/components-react for audio UI

### Side Chat: WebSocket + PostgreSQL
- Chat messages stored in board_chat_messages table
- Delivered via the same WebSocket connection (separate channel)
- Persistent — new joiners see recent history
- Supports @mentions, emoji reactions

### Multitouch
- Phase 1: tldraw's built-in touch support (pinch-zoom, two-finger pan, single-finger draw)
- touch-action: none on canvas element
- Works for single user with multitouch gestures
- Multiple remote users collaborate via separate devices/windows

## Build Agent Breakdown (10 agents)

### Agent 1: Database Migration + Drizzle Schema
- Migration 0031_board_tables.sql (8 tables: boards, board_elements, board_versions, board_task_links, board_collaborators, board_templates, board_stars, board_chat_messages)
- Drizzle schema files in apps/board-api/src/db/schema/

### Agent 2: Board API Backend (Routes + Services)
- 6 route files: boards, elements, versions, links, templates, collaborators
- 6+ service files: board CRUD, element snapshot, task promotion, canvas reader
- Auth middleware with board access/edit guards

### Agent 3: Board API WebSocket + Collaboration
- Hocuspocus plugin for Yjs sync
- Yjs persistence to PostgreSQL
- Awareness protocol for presence
- Chat message WebSocket channel
- LiveKit room management (create/join room on board open)

### Agent 4: Board Frontend - Canvas + tldraw
- tldraw integration with sync provider
- Custom shapes (BamTaskEmbed, BeaconEmbed, BearingGoalEmbed, BriefEmbed)
- Canvas toolbar (shapes, sticky, draw, frame, embed picker)
- Export functionality (SVG/PNG)
- Multitouch: touch-action:none, pinch-zoom, pan

### Agent 5: Board Frontend - Layout, List, Sidebar
- Board list page (grid of thumbnails)
- Board layout with sidebar (collaborators, versions, linked tasks, chat)
- Template browser page
- Presence bar (active collaborators with colored cursors)
- Board settings (name, background, visibility, lock)

### Agent 6: Board Frontend - Audio + Chat
- LiveKit audio integration (@livekit/components-react)
- Auto-join room on board open, leave on close
- Mute/unmute controls in toolbar
- Speaker indicators on collaborator avatars
- Side chat panel: message list, compose input, @mentions
- Chat history loaded from API

### Agent 7: MCP Tools (14 tools)
- board_list, board_get, board_create, board_update, board_archive
- board_read_elements, board_read_stickies, board_read_frames
- board_add_sticky, board_add_text
- board_promote_to_tasks, board_summarize, board_search, board_export

### Agent 8: Docker/nginx + Cross-app Nav
- Docker service (board-api port 4008)
- nginx routing (/board/, /board/api/, /board/ws)
- Frontend Dockerfile (build board SPA)
- Cross-app nav pills in all 8 existing apps

### Agent 9: Templates + Seed Data
- 10 system templates (retro, brainstorm, architecture, etc.)
- Migration 0032_board_system_templates.sql
- Seed script with 8-10 demo boards with elements
- Screenshot script

### Agent 10: Tests + Security Audit
- Test files for board CRUD, elements, versions, links, auth
- Security audit of all board-api routes
- Fix P0/P1 issues
