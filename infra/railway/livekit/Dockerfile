# Passthrough image for deploying LiveKit on Railway. The upstream image is
# distroless-style and ships only the binary, so we use a tiny alpine layer
# at the top to provide envsubst (gettext) and a shell, then copy the
# binary out of the upstream image and start it via our entrypoint.
#
# The entrypoint renders /etc/livekit.yaml.tmpl into /etc/livekit.yaml at
# EVERY container start from environment variables — Railway's equivalent
# of the compose stack's livekit-config init service (config can't go
# stale). It also writes the TURN-TLS cert/key from env PEMs and reports
# boot topology to the platform Log. See entrypoint.sh for the full env
# contract and docs/livekit-networking-notes.md for the architecture.
#
# Version is PINNED to match the compose stack so local and Railway run
# byte-identical servers (the binary is copied from the official image,
# not re-downloaded).
FROM alpine:3.20

# socat powers the TURN port-alignment relay: Railway assigns the TCP
# proxy's PUBLIC port randomly (no update mutation, no requested-port
# field — verified against their GraphQL schema), while LiveKit has a
# single turn.tls_port field controlling both its listen AND advertised
# port. The entrypoint therefore points the Railway proxy at a FIXED
# container port (5349) and relays it to wherever LiveKit listens
# (the public port number), keeping advertised == reachable.
RUN apk add --no-cache gettext ca-certificates socat

COPY --from=livekit/livekit-server:v1.11.0 /livekit-server /livekit-server

COPY infra/railway/livekit/livekit.yaml.tmpl /etc/livekit.yaml.tmpl
COPY infra/railway/livekit/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 7880 = HTTP/WS signaling (reached via the frontend nginx /livekit-ws
# proxy over Railway private networking). 7881 = ICE-TCP (unreachable
# from the public internet on Railway; TURN is the media path). The
# TURN-TLS listener port is dynamic (LIVEKIT_TURN_TLS_PORT, matched to
# the Railway TCP proxy) — EXPOSE is documentation-only on Railway, so
# its absence here is fine.
EXPOSE 7880 7881

ENTRYPOINT ["/entrypoint.sh"]
