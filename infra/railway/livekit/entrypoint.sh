#!/bin/sh
# Render the LiveKit config template with env vars at container start, then
# exec livekit-server with it — Railway's equivalent of the compose stack's
# livekit-config init service: the config can never go stale because it is
# rebuilt from env on every boot.
#
# Railway network reality (why this config looks the way it does): the
# container sits behind Railway's edge — no public IP on the interface, no
# public UDP at all, ingress only via the HTTP edge or TCP proxies. The
# ONLY workable WebRTC media path is therefore TURN over TLS on a Railway
# TCP proxy: browsers dial OUT to turns://<domain>:<port> (plain TCP
# ingress, which Railway can do) and LiveKit relays media in-process.
# Signaling rides the frontend nginx at /livekit-ws over Railway private
# networking to :7880 here.
#
# Env contract (set on the Railway livekit service):
#   LIVEKIT_API_KEY / LIVEKIT_API_SECRET    required (shared with the apis)
#   LIVEKIT_WEBHOOK_URL                     default: banter-api internal :8080
#   LIVEKIT_TURN_DOMAIN                     e.g. turn.bigbluebam.com
#   LIVEKIT_TURN_TLS_PORT                   the Railway TCP proxy's PUBLIC
#                                           port. LiveKit listens on AND
#                                           advertises this number, so the
#                                           proxy's target port must be set
#                                           to the same value ("port
#                                           alignment dance" — see
#                                           docs/livekit-networking-notes.md)
#   LIVEKIT_TURN_CERT_PEM / LIVEKIT_TURN_KEY_PEM
#                                           PEM bodies for the TURN domain.
#                                           Browsers VALIDATE TURN-TLS certs;
#                                           self-signed will not work.
#   INTERNAL_SERVICE_SECRET (+ BBB_API_INTERNAL_URL)
#                                           optional: boot topology report
#                                           into the platform Log
#
# All four LIVEKIT_TURN_* vars must be present for TURN to render;
# otherwise LiveKit boots signaling-only and the boot report says so loudly.
set -e

: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY is required}"
: "${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET is required}"
# banter-api listens on 8080 on Railway (the platform convention nginx
# proxies to); the previous :4002 default pointed at the compose port and
# silently broke webhook-driven call-participant tracking on Railway.
# The export is load-bearing: `:=` assigns a SHELL variable only, and
# envsubst runs as a child process — without the export the template's
# webhook url rendered EMPTY (the original script had exactly this bug).
: "${LIVEKIT_WEBHOOK_URL:=http://banter-api.railway.internal:8080/v1/webhooks/livekit}"
export LIVEKIT_WEBHOOK_URL

CONF_DIR=/etc/livekit
mkdir -p "$CONF_DIR"

# ── TURN block (multi-line value substituted by envsubst) ───────────
TURN_ENABLED=false
TURN_BLOCK="# turn: disabled — set LIVEKIT_TURN_DOMAIN, LIVEKIT_TURN_TLS_PORT,
# LIVEKIT_TURN_CERT_PEM and LIVEKIT_TURN_KEY_PEM to enable. On Railway
# TURN is not optional polish: it is the ONLY media path, so without it
# calls fail at the media stage with BUREAU_CONNECT_FAILED."

if [ -n "${LIVEKIT_TURN_DOMAIN:-}" ] && [ -n "${LIVEKIT_TURN_TLS_PORT:-}" ] \
   && [ -n "${LIVEKIT_TURN_CERT_PEM:-}" ] && [ -n "${LIVEKIT_TURN_KEY_PEM:-}" ]; then
  printf '%s\n' "$LIVEKIT_TURN_CERT_PEM" > "$CONF_DIR/turn.crt"
  printf '%s\n' "$LIVEKIT_TURN_KEY_PEM" > "$CONF_DIR/turn.key"
  chmod 600 "$CONF_DIR/turn.key"
  TURN_ENABLED=true
  TURN_BLOCK="turn:
  enabled: true
  domain: ${LIVEKIT_TURN_DOMAIN}
  tls_port: ${LIVEKIT_TURN_TLS_PORT}
  cert_file: ${CONF_DIR}/turn.crt
  key_file: ${CONF_DIR}/turn.key"
  echo "[livekit-railway] TURN-TLS enabled: turns://${LIVEKIT_TURN_DOMAIN}:${LIVEKIT_TURN_TLS_PORT}"
else
  echo "[livekit-railway] TURN-TLS disabled (LIVEKIT_TURN_* env incomplete) — signaling will work, public-internet media will NOT"
fi
export TURN_BLOCK

envsubst < /etc/livekit.yaml.tmpl > /etc/livekit.yaml
echo "[livekit-railway] rendered /etc/livekit.yaml (turn=${TURN_ENABLED}, webhook=${LIVEKIT_WEBHOOK_URL})"

# ── Boot topology report into the platform Log (best-effort) ───────
if [ -n "${INTERNAL_SERVICE_SECRET:-}" ]; then
  API_BASE="${BBB_API_INTERNAL_URL:-http://api.railway.internal:8080}"
  if [ "$TURN_ENABLED" = "true" ]; then
    CODE="LIVEKIT_RAILWAY_BOOT"
    MSG="LiveKit (Railway) booted with TURN-TLS at turns://${LIVEKIT_TURN_DOMAIN}:${LIVEKIT_TURN_TLS_PORT}. Signaling rides /livekit-ws; media relays through TURN (Railway has no public UDP)."
  else
    CODE="LIVEKIT_RAILWAY_NO_TURN"
    MSG="LiveKit (Railway) booted WITHOUT TURN: signaling works but media cannot connect from the public internet (Railway has no public UDP and direct ICE candidates are unreachable). Set LIVEKIT_TURN_DOMAIN, LIVEKIT_TURN_TLS_PORT, LIVEKIT_TURN_CERT_PEM, LIVEKIT_TURN_KEY_PEM on the livekit service — see docs/livekit-networking-notes.md."
  fi
  wget -q -O /dev/null --timeout=5 \
    --header "content-type: application/json" \
    --header "x-internal-secret: ${INTERNAL_SERVICE_SECRET}" \
    --post-data "{\"service\":\"livekit-config\",\"error_code\":\"${CODE}\",\"message\":\"${MSG}\",\"payload\":{\"turn_enabled\":${TURN_ENABLED}}}" \
    "${API_BASE%/}/internal/system-errors/record" \
    && echo "[livekit-railway] boot topology reported to the platform Log" \
    || echo "[livekit-railway] Log report skipped (api unreachable — expected on cold boot)"
fi

# Test hook: render-only mode for CI / local smoke checks.
if [ "${1:-}" = "--print-config" ]; then
  cat /etc/livekit.yaml
  exit 0
fi

exec /livekit-server --config /etc/livekit.yaml
