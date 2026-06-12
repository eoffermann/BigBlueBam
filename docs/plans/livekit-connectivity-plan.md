# LiveKit Connectivity Plan — LAN + WAN clients, zero hardcoded addresses

**Status: APPROVED WITH DECISIONS — implementing.**
Date: 2026-06-12

## 0. Review decisions (Eddie, 2026-06-12)

The three §8 open questions were answered, changing the design as follows:

1. **Port-forwarding is a deployment variable, not an assumption.** Eddie's own
   deploys never need it (dev box is LAN-only; public server has no NAT), but
   other deployers will. Decision: the system must *detect* the behind-NAT
   topology itself and report it to the Log (system_errors → SuperUser Log
   Analysis tab) with the exact forwards required, so a third-party deployer
   can self-diagnose. No reliance on the operator reading docs first.
2. **No static-IP assumption anywhere.** Render-once-at-deploy-time is a
   failure mode, not a solution. Decision: WAN re-detection runs at every
   container boot (init container, replacing the deploy-script-only render),
   and an hourly worker job re-checks the WAN IP and writes a drift warning
   to the Log when LiveKit is advertising a stale address — with the exact
   remediation command in the message.
3. **No shortcuts on connectivity.** Decision: ICE-TCP fallback stays, TURN
   support is implemented (cert-gated, off until a domain + cert are
   provided), and every connection-failure path must put enough context in
   the Log for another engineer to solve it without reproducing: client-side
   failures carry page-host/network context; server-side renders carry the
   advertised candidate set and topology.

**Implementation correction (discovered during build, 2026-06-12):** the
`nat_1to1_ips` multi-address key this plan proposed does not exist in the
deployed livekit-server build — the binary rejects it at config-parse time
(verified empirically; the accepted fields were probed from the binary
itself). The replacement is protocol-level rather than config-level, and is
strictly more robust: render a single `node_ip` (LAN) advertisement plus
`use_ice_lite: false` (FULL ICE — the server actively probes every client's
own candidates, which is the real per-connection LAN-vs-WAN negotiation) plus
`stun_servers` (the server learns its public mapping per media socket, giving
remote clients a public target). Behind-NAT deployments get deterministic
remote media with router forwards or TURN; without them, remote works on
cone-NAT clients and the `LIVEKIT_BEHIND_NAT` Log row says exactly what to do.
Everything else below (detection, init service, drift monitor, reporting,
TURN) shipped as written. See `docs/livekit-networking-notes.md` for the
operator-facing reference.

Revised architecture below supersedes §3–§4 where they conflict:

- **`scripts/livekit/render-config.mjs`** — zero-dependency, runs in two modes.
  Host mode (deploy script / operator one-liner): detects the LAN IP via the
  UDP-connect routing trick, persists it to `infra/livekit/.lan-ip`
  (gitignored). Container mode (the `livekit-config` init service, every
  `docker compose up`): re-detects the WAN IP via STUN (HTTPS fallback),
  reads the persisted LAN IP, renders `livekit.yaml` from the template with
  a `nat_1to1_ips` list, writes `advertised.json`, and POSTs a topology row
  to the internal system-errors endpoint when the state changed.
- **Compose changes:** new one-shot `livekit-config` service (node:22-alpine)
  that LiveKit `depends_on` (same pattern as `migrate`); LiveKit mounts the
  config *directory* instead of the single file (kills the historic
  file-vs-directory bind-mount gotcha); UDP range env var now drives both
  the port mapping and the rendered config so they can't drift apart.
- **Worker:** hourly `livekit-ip-drift` job — STUN-detects current WAN,
  compares to `advertised.json` (read-only mount), inserts a
  `LIVEKIT_WAN_IP_DRIFT` row on mismatch (deduped by value).
- **bureau-client:** failure reports gain page-host + private-network
  context. No changes to connection/calling logic.
- **TURN:** rendered `turn:` block when `LIVEKIT_TURN_DOMAIN` + cert/key are
  configured; compose maps 5349/tcp; documented in the networking notes.

## 1. Problem statement

The Bureau docked widget shows a red `error` next to `[R] In: <Room>` for any
client that cannot complete a WebRTC media connection to LiveKit. The browser-side
error capture (commit `df0b188`) pinpointed it: `BUREAU_CONNECT_FAILED`,
`stage: room-connect`, `error_name: ConnectionError` — the LiveKit signaling
WebSocket connects fine (it rides nginx at `/livekit-ws`), but the *media*
(ICE/DTLS) leg fails because the server advertises candidate addresses the
client can't reach.

History of the config states, with evidence:

| Config state | Who could connect | Why it failed for others |
|---|---|---|
| `node_ip: 127.0.0.1`, `use_external_ip: false` (original) | Browser on the LiveKit host only | All candidates pointed at loopback. Second machine: DTLS timeout. |
| `use_external_ip: true` (commit `df0b188`-era) | WAN clients, *if* router forwards existed | STUN advertises only the WAN IP (`203.0.113.7`). LAN clients need hairpin NAT, which consumer routers do badly or not at all. |
| `node_ip: <LAN IP>`, `use_external_ip: false` + UDP range mapped (commit `a48f316`) | LAN clients (verified: both machines, `connectionType: udp`, ~100ms) | WAN clients get only the LAN candidate — meaningless outside the LAN. |
| `node_ip + use_external_ip: true` (uncommitted experiment) | WAN only | **Empirical finding:** `use_external_ip: true` *replaces* `node_ip` rather than composing with it. `publisherCandidates` log at 13:28:34 showed only `203.0.113.7` host candidates. LAN broke again. |

The conclusion: a single advertised address can never serve both populations.
The server must advertise **both** and let the client pick.

## 2. How the negotiation actually works (and why no app code changes)

WebRTC's ICE (Interactive Connectivity Establishment) is precisely the
"figure out if the client is on LAN or WAN at connect time" mechanism:

1. The server hands every joining client a **list** of candidate
   transport addresses (IP+port+protocol).
2. The client's browser sends STUN connectivity checks to **every candidate
   in parallel** (~50–200 ms).
3. The first/best candidate pair that succeeds is nominated. Unreachable
   candidates are simply discarded — that's by design, not an error.

So a LAN client offered `[192.168.1.42, 203.0.113.7]` connects to the LAN IP
(direct, ~5 ms). A remote client offered the same list fails the LAN probe
in milliseconds and lands on the WAN IP. Nobody configures anything per-client;
no application logic asks "are you local?". **The bureau-client, bureau-api,
and all calling code stay untouched.** The entire fix is server-side candidate
advertisement plus port reachability.

LiveKit's config knob for advertising multiple addresses is `rtc.nat_1to1_ips`
(a YAML list). Each listed IP becomes a host candidate for every media port.
This is the only LiveKit mechanism that advertises several addresses at once
(`node_ip` is single-valued; `use_external_ip` overrides it — see §1 table).

The signaling path needs **no change**: bureau-api returns `ws_url` as a
relative path, bureau-client resolves it against `window.location.host`, and
nginx proxies `/livekit-ws` → `livekit:7880`. Signaling automatically follows
whatever hostname/IP the browser is already using. Verified working in both
the LAN-IP and domain-name access patterns tonight.

## 3. Where addresses come from (the part I got wrong)

**Principle: no IP address ever appears in a tracked file.** The committed
artifacts are a template + a renderer. The rendered `infra/livekit/livekit.yaml`
is gitignored (verified: only `livekit.yaml.template` is tracked) and is a
per-deploy artifact exactly like `.env`. Detection happens at render time on
the host:

### LAN IP — auto-detected, no dependencies
Open a UDP socket and `connect()` it to a public address (e.g. `8.8.8.8:53`).
No packet is sent for UDP connect; the OS just resolves routing and exposes
the source IP it *would* use via `socket.address()`. This returns the IP of
the interface holding the default route — on Eddie's machine that's
`192.168.1.42`, correctly skipping the two `vEthernet` adapters (they have no
default gateway). Works identically on Windows/macOS/Linux, ~10 lines of
`node:dgram`, zero deps. This is robust where "first non-internal IPv4 from
`os.networkInterfaces()`" is not (multi-NIC, VPN, Hyper-V adapters).

### WAN IP — auto-detected, two-tier
1. **STUN binding request** to a public STUN server (`stun.l.google.com:19302`,
   fallback `global.stun.twilio.com:3478`) over UDP — ~60 lines of
   `node:dgram`, the same mechanism LiveKit itself uses, no HTTP dependency.
   Bonus: if STUN over UDP works from the host, WebRTC UDP likely works too.
2. **HTTPS fallback** (`api.ipify.org`, then `checkip.amazonaws.com`) with a
   2 s timeout, for networks where outbound UDP is filtered.

### Operator overrides (all optional, in `.env`)
| Var | Default | Meaning |
|---|---|---|
| `LIVEKIT_NODE_IP` | `auto` | Local/LAN advertise IP. `auto` = UDP-connect detection. Explicit value for multi-NIC hosts where detection would pick the wrong interface. |
| `LIVEKIT_EXTERNAL_IP` | `auto` | Public advertise IP. `auto` = STUN/HTTPS detection. `none` = don't advertise a WAN candidate (air-gapped / LAN-only deploys). Explicit value for cloud 1:1 NAT (e.g. AWS EIP). |
| `LIVEKIT_UDP_PORT_RANGE` | `51000-51100` | Already exists (commit `a48f316`). Range chosen to dodge Windows' reserved 50000–50259 block. |

### Render decision matrix
```
detected = dedupe([ resolve(LIVEKIT_NODE_IP), resolve(LIVEKIT_EXTERNAL_IP) ])
  - both found, different      → nat_1to1_ips: [lan, wan]     (the normal self-hosted case)
  - both found, identical      → nat_1to1_ips: [ip]           (cloud VM with public IP on the interface)
  - only one found             → nat_1to1_ips: [ip] + console warning naming which detection failed
  - none found                 → use_external_ip: true + loud warning (LiveKit boot-time STUN as last resort)
```
The renderer prints what it detected and why, so a deploy log always shows
the chosen advertisement set.

## 4. Deliverables

1. **`scripts/render-livekit-config.mjs`** — new standalone module exporting
   `detectLanIp()`, `detectWanIp()`, `buildRtcBlock(env, detected)`, and a
   CLI entrypoint, so the same code serves three callers:
   - the deploy adapter (`docker-compose.mjs` imports it; deletes its current
     inline `renderLivekitConfig` logic),
   - the operator directly: `node scripts/render-livekit-config.mjs && docker compose up -d --force-recreate livekit`
     (the documented "my network changed" one-liner),
   - unit tests (pure `buildRtcBlock` with injected detection results).
2. **Template cleanup** — `livekit.yaml.template` keeps a single
   `__LIVEKIT_RTC_BLOCK__` placeholder + a comment explaining ICE in two
   sentences. The half-edited comment blocks from tonight's uncommitted
   experiments get replaced wholesale.
3. **`.env.example`** — document the three vars per the table above.
4. **`docs/livekit-networking-notes.md`** — operator-facing notes (per our
   docs convention for sharp edges): the router port-forward table, the
   IP-rotation caveat, the Windows port-reservation gotcha, the candidate-list
   verification command, and the TURN follow-up. CLAUDE.md gets two lines
   pointing at it.
5. **Unit tests** for `buildRtcBlock` covering the four matrix rows + override
   precedence + `none` semantics + dedupe.
6. **Working-tree cleanup** — tonight's uncommitted edits to
   `docker-compose.mjs`, the template, and `.env.example` are superseded by
   the above and will be replaced, not layered on.

## 5. Network prerequisites (cannot be solved in software)

For a self-hosted node behind a NAT router, WAN media requires router
port-forwards to the host. This is inherent to hosting an SFU behind NAT —
documented, not worked around:

| Port | Proto | Purpose | Required for |
|---|---|---|---|
| 443 | TCP | nginx (app + LiveKit signaling) | already forwarded (bigbluebam.com works) |
| 7881 | TCP | ICE-TCP media fallback | minimum viable WAN media (degraded quality) |
| 51000–51100 | UDP | RTP/RTCP media | full-quality WAN media |

Port 7880 does **not** need forwarding (signaling rides nginx). LAN clients
need nothing beyond what `a48f316` already shipped (host UDP mapping). If
the forwards are absent, WAN clients fail media — and the browser-side
reporter now logs exactly that as `BUREAU_CONNECT_FAILED` with the candidate
context, so it's diagnosable from the SuperUser tab rather than invisible.

## 6. Explicitly out of scope (this pass)

- **No changes to bureau-client / bureau-api / any calling code.** ICE already
  negotiates per-client; the calling path was verified correct tonight.
- **No application-level "am I on LAN?" logic.** That would re-implement ICE,
  badly.
- **Embedded TURN server** — the right answer for clients on hostile networks
  (UDP-blocking corporate firewalls) and the only way to avoid router
  forwards entirely (TURN-TLS on a single TCP port). Flagged as a follow-up
  decision, not blocking the LAN+WAN base case.
- **IPv6 candidates** — same mechanism, more detection; defer.
- **Boot-time re-detection** (an entrypoint shim that re-runs STUN on every
  container start, auto-healing WAN IP rotation) — noted as a Phase 2 option;
  for now the documented recovery is the render one-liner in §4.1.

## 7. Verification plan

1. **Unit:** `buildRtcBlock` matrix tests (no network in CI; detection injected).
2. **Candidate audit (the ground truth):** after render + `up -d
   --force-recreate livekit` (force-recreate, not restart — bind-mount +
   Docker Desktop have burned us on stale reads before), join a room and run:
   `docker compose logs livekit | grep publisherCandidates | tail -1`
   Must show host candidates for **both** the LAN IP and the WAN IP.
3. **Three-origin matrix:**
   - browser on the Docker host → connects (UDP, LAN candidate)
   - browser on a second LAN machine → connects (UDP, LAN candidate) — tonight's regression case
   - browser on a phone on LTE (Wi-Fi off) via bigbluebam.com → connects via WAN candidate **iff** §5 forwards exist; otherwise produces a `BUREAU_CONNECT_FAILED` row proving the observability loop
4. **Negative:** no `dtls timeout` warnings in LiveKit logs for any of the three.

## 8. Open questions for Eddie before implementation

1. **Router forwards:** are TCP 7881 and UDP 51000–51100 currently forwarded
   to this host (443 evidently is)? Determines whether the WAN leg of the
   matrix can pass today or needs a router change first.
2. **WAN IP stability:** is 203.0.113.7 effectively static? If your ISP
   rotates it, do you want the Phase-2 boot-time re-detection shim now
   instead of the documented re-render one-liner?
3. **TURN:** want the embedded-TURN follow-up planned (single-port TCP
   fallback, helps corporate-network guests), or park it?
