# LiveKit networking — how calls connect, what's detected, what the Log tells you

Operator + engineer notes for the calling stack (Bureau, Banter, Board — anything
riding the shared LiveKit SFU). Companion to
`docs/plans/livekit-connectivity-plan.md` (the design history) and the rendered
artifacts in `infra/livekit/`.

## The one-paragraph model

WebRTC media does not flow through nginx; the browser talks to LiveKit
directly. Connectivity is negotiated **per client, per connection** by ICE:
the server advertises an address, the client offers its own addresses, and —
because we run **full ICE** (`use_ice_lite: false`) — *both sides* probe *all*
pairs in parallel and keep the first that works. A LAN client and a remote
client connect to the same server simultaneously through different paths,
and no application code ever asks "is this client local?". Signaling
(`/livekit-ws`) does ride nginx, so it automatically follows whatever
hostname/IP the browser already used and needs no configuration.

## What is detected, where, and when

| Thing | Detected by | When | Mechanism |
|---|---|---|---|
| Host LAN IP | `scripts/livekit/render-config.mjs --mode=host` | every deploy-script run, or the operator one-liner | UDP-connect routing trick (no packets sent; picks the interface with the default route, skips Hyper-V/VPN adapters). Persisted to `infra/livekit/.lan-ip` because containers cannot see host interfaces. |
| Public (WAN) IP | `livekit-config` compose init service (same script, `--mode=container`) | **every `docker compose up`**, before livekit starts | STUN (Google, then Twilio), HTTPS fallback (ipify, AWS). Never stale across restarts. |
| WAN IP rotation while running | `livekit-ip-drift` worker job | hourly at :17 | Fresh STUN vs `infra/livekit/advertised.json`; on mismatch writes `LIVEKIT_WAN_IP_DRIFT` to the Log with the fix command. Deduped per transition. |
| NAT topology | `livekit-config` | every render (reported only on change) | LAN ≠ WAN ⇒ behind NAT ⇒ `LIVEKIT_BEHIND_NAT` row listing the exact forwards. |

All rendered/detected state lives in gitignored files: `infra/livekit/livekit.yaml`,
`.lan-ip`, `advertised.json`. **No IP address exists in any tracked file.**

## Env overrides (`.env`) — all optional, defaults shown

```
LIVEKIT_NODE_IP=auto          # LAN advert: auto-detect | none | explicit IPv4 (multi-NIC hosts)
LIVEKIT_EXTERNAL_IP=auto      # public:    auto (STUN every boot) | none (air-gapped; silences NAT row) | explicit (cloud 1:1 NAT)
LIVEKIT_UDP_PORT_RANGE=51000-51100   # drives BOTH the docker mapping and the rendered config
LIVEKIT_TURN_DOMAIN=          # all three set → TURN-TLS on :5349 (see below)
LIVEKIT_TURN_CERT_FILE=/certs/local.crt
LIVEKIT_TURN_KEY_FILE=/certs/local.key
```

## Deployment matrix

| Deployment | What happens | Operator action |
|---|---|---|
| Dev box on a LAN (e.g. this repo's primary) | LAN clients direct via `node_ip`; the `LIVEKIT_BEHIND_NAT` Log row appears once, informationally | none (set `LIVEKIT_EXTERNAL_IP=none` to silence the row if remote access is never wanted) |
| Public server, no NAT | LAN==WAN dedupes to one address; everything direct | none |
| Self-hosted behind NAT, remote users wanted | LAN clients direct; remote clients use the server's STUN-discovered public mapping — works on most home/cone NATs, **not guaranteed** | for deterministic remote media: forward **TCP 7881** + **UDP 51000-51100** to the host (the `LIVEKIT_BEHIND_NAT` row repeats this), or set up TURN |
| Air-gapped / LAN-only | `LIVEKIT_EXTERNAL_IP=none`: no STUN, no NAT row, LAN-only advert | none |

## Log rows reference (SuperUser → Log Analysis)

| error_code | service | Meaning / action |
|---|---|---|
| `LIVEKIT_BEHIND_NAT` | livekit-config | Topology info: LAN+public differ. Lists the forwards remote media needs. Ignorable for LAN-only deploys. |
| `LIVEKIT_LAN_IP_UNKNOWN` | livekit-config | Container render had no persisted LAN IP (stack started without ever running the host-side render). LAN callers may fail. Fix: `node scripts/livekit/render-config.mjs` on the host, then recreate livekit-config+livekit. |
| `LIVEKIT_WAN_DETECT_FAILED` | livekit-config | No STUN/HTTPS egress; no public advert. Remote callers will fail. Set `LIVEKIT_EXTERNAL_IP` or `=none` if intentional. |
| `LIVEKIT_ADVERTISE_FALLBACK` | livekit-config | Nothing usable detected or configured; LiveKit fell back to boot-time STUN. Fix LAN and/or WAN per the row text. |
| `LIVEKIT_WAN_IP_DRIFT` | worker | ISP rotated the public IP after the last render. Run `docker compose up -d --force-recreate livekit-config livekit`. |
| `BUREAU_MINT_FAILED` / `BUREAU_CONNECT_FAILED` | frontend/* | A user actually saw a red call error. `page_host_kind` says which side they were on: `private-ip`/`loopback` ⇒ LAN path (check LAN advert + NAT row), `public-ip`/`hostname` ⇒ remote path (check forwards / TURN / drift). Includes the LiveKit error reason and stack. |

## TURN (relay of last resort)

For callers on networks that block direct UDP/TCP media entirely
(strict corporate firewalls), enable LiveKit's embedded TURN-TLS:

1. DNS: point a name (e.g. `turn.example.com`) at the deployment.
2. Cert: the livekit container mounts `./certs` at `/certs`; provide a cert/key
   valid for that name (the Let's Encrypt flow in the deploy script, or any
   other source).
3. `.env`: set `LIVEKIT_TURN_DOMAIN`, `LIVEKIT_TURN_CERT_FILE`,
   `LIVEKIT_TURN_KEY_FILE`; recreate `livekit-config` + `livekit`.
4. Reachability: TCP **5349** must reach the host (mapped by compose; forward
   it on the router for behind-NAT deploys).

Clients receive the TURN server in the join handshake automatically; no
client-side config.

## Verification

```sh
# What is currently advertised?
cat infra/livekit/advertised.json

# Did livekit-config run and what did it decide?
docker compose logs livekit-config

# Is livekit running the rendered config? (nodeIP + ICE range in one line)
docker compose logs livekit | grep "starting LiveKit"

# Ground truth — the candidates offered for a real join, after someone joins a call:
docker compose logs livekit | grep publisherCandidates | tail -1

# Topology / drift rows in the Log (or use SuperUser → Log Analysis):
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c \
  "SELECT service, error_code, left(message,80) FROM system_errors \
   WHERE error_code LIKE 'LIVEKIT_%' ORDER BY created_at DESC LIMIT 5;"
```

## Sharp edges

- **Windows reserved UDP ports.** Docker Desktop + Windows reserves
  50000-50259 (`netsh int ipv4 show excludedportrange protocol=udp`); binding
  there fails with a permissions error. That's why the default media range is
  51000-51100. If you change `LIVEKIT_UDP_PORT_RANGE`, the same value flows to
  both the port mapping and the config — both sides of the mapping must stay
  identical because WebRTC advertises the container-local port numbers.
- **This livekit-server build has no multi-address advertisement.** The
  `nat_1to1_ips` key (pion's API name) is rejected at parse time — verified
  against the binary. Multi-network reachability comes from full ICE + STUN
  instead; do not "fix" the config by re-adding a candidates list.
- **`docker compose restart livekit` does NOT re-render.** `restart` skips
  dependency one-shots. Use
  `docker compose up -d --force-recreate livekit-config livekit` — every
  remediation message says exactly this.
- **Host reboot staleness window.** After a host reboot, containers auto-start
  without re-running the host-side LAN detection; if the WAN rotated during the
  outage the boot-time container render catches it, and any later rotation is
  caught by the hourly drift row. A LAN IP change (rare for a stationary
  server) requires the host-side one-liner.
- **LiveKit config is not hot-reloaded.** Any render only takes effect when
  the livekit container restarts; that's why every fix command recreates it.
