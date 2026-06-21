# Bureau - Virtual Office

Bureau is the spatial-presence layer of the BigBlueBam suite. It gives a remote team the feel of a shared office: a set of floors laid out on a canvas, rooms you can walk into, live occupant dots for everyone who is around, and a floating presence widget that follows you into every other app. Where chat tells you what was said, Bureau tells you who is here, whether you can interrupt them, and whether you can all jump to the same screen right now.

The product is built around a small set of objects. A **floor** is one navigable office map. A **room** is an addressable space on a floor, mapped one-to-one to a real-time audio room, in one of eight types from a one-person **office** to a **conference** room or an open **lounge**. Your **presence** is your live state - which room you are in, your status, and the page you are viewing - and it lives on the server, so moving between pages never drops your session. **Door states** (Open, Knock, Private) decide who can walk in, and **knocks**, **summons**, **rings**, and **hunts** are the social moves that connect people across the office.

Bureau is the source of the floating docked box that the rest of the suite shows. That widget is what makes a voice huddle follow you from a Board canvas to a Brief doc, what shows you the "X others here" on any surface, and what carries the one-click Bring everyone here, Invite, and Hunt actions wherever you are.

## Key Features

- **Floor directory and live floor maps.** Browse floors with live occupancy counts, then drop into a Canvas2D map that draws one rectangle per room with a dot for each occupant. Click a room to enter it; the map updates in real time as people move and change status.
- **Move, knock, and admit.** Enter Open rooms freely, knock on closed offices (auto-timed-out after 30 seconds), and triage knocks at your own door with Let in, Not now, or Decline. Head-down DND blocks knocks and offers visitors a leave-a-note path.
- **Summon, Ring, and Hunt.** Bring everyone in your room to a resource in another app, ring one specific person to your screen, or hunt a teammate and jump to wherever they are. Every action is access-checked, so no one is sent a link they cannot open and no one's location leaks through a surface you could not see.
- **Cross-app docked box.** A draggable presence and call console rendered inside every SPA, with mic, camera, screen share, ephemeral room chat, the live door-privacy toggle, and the DND switch.
- **Room booking.** A dedicated Room booking screen lists the org's bookable rooms by floor; pick one, see its upcoming reservations, and book a window with open or locked access. The reservation mirrors to a Book event and schedules jobs that flip the room private at the start and clear it at the end.
- **Live presence and status.** Your status (available, busy, away, dnd, focus, in_meeting) and the room and floor you are in are tracked live, surfaced on the floor map and the docked box, and persisted on the server so they survive a reconnect and apply even when you have no live web session.
- **Recent chats with retention.** Room chats are ephemeral (24 hours by default), but participants can recover transcripts, and admins can extend retention up to a week or pin a thread permanently.
- **Floor and office administration, and org settings.** Org admins build floors on a canvas editor, place rooms and offices, set door defaults and capacities, upload a background underlay, and assign or reassign who owns each personal office. A Bureau settings screen controls org-wide defaults: continuous audio, auto-follow, whether members can book or create rooms, and the default office privacy.

## Integrations

- **Board, Brief, and Bond** are the common summon and ring destinations; each surface carries a huddle the docked box auto-joins, and Board renders the same widget so the canvas call follows you in.
- **Banter** surfaces the same docked box and is the delivery channel for the leave-a-note DND fallback, posting "[Bureau knock note] " direct messages.
- **Book** mirrors every Bureau booking as a calendar event and is cancelled best-effort when the booking is cancelled.
- **Bolt** receives Bureau events (room entry and exit, status changes, knocks, room booked, room locked, summon issued) on the `bureau` source for automation.
- **Bench** rolls up daily floor utilization for reporting.
- **AI agents** treat Bureau as a place they can occupy. Through over 30 `bureau_*` MCP tools they locate people, knock, summon, manage floors and offices, book rooms, and recover chats - all under the same server-side permission checks as the UI, the suite-wide `agent_policies` kill switch and allowlists, and the `can_access` visibility preflight before any cross-app result is posted.

## Getting Started

1. Sign in to BigBlueBam, then open Bureau at `/bureau/`. Bureau shares your Bam session.
2. On the **Floors** landing, click a floor card to open its live map.
3. Click an Open room rectangle to enter it; your dot appears inside and your audio connects. Use **Leave room** to step out.
4. Watch the docked box: it names your room, who is with you, and the page you are viewing, and it exposes Bring everyone here, Invite, Hunt, and the DND toggle.
5. To reserve a meeting space, open **Book a room** (under Rooms), pick a bookable room, and book a window with locked or open access.
6. If you are an org admin, open **Edit floors** to build a floor on the canvas editor, **Offices** to assign who owns each personal office, and **Settings** to set org-wide defaults for audio, auto-follow, and member booking and room creation.

## Working together

Bureau is the virtual office and the presence layer the rest of the suite plugs into: live floors and rooms, and a presence and location that follow you across every app.
