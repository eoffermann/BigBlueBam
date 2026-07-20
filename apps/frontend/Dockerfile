# ── Stage: deps ───────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml* ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/helpdesk/package.json ./apps/helpdesk/
COPY apps/banter/package.json ./apps/banter/
COPY apps/beacon/package.json ./apps/beacon/
COPY apps/brief/package.json ./apps/brief/
COPY apps/bolt/package.json ./apps/bolt/
COPY apps/bearing/package.json ./apps/bearing/
COPY apps/board/package.json ./apps/board/
COPY apps/bond/package.json ./apps/bond/
COPY apps/blast/package.json ./apps/blast/
COPY apps/book/package.json ./apps/book/
COPY apps/bench/package.json ./apps/bench/
COPY apps/basis/package.json ./apps/basis/
COPY apps/braid/package.json ./apps/braid/
COPY apps/bulwark/package.json ./apps/bulwark/
COPY apps/burn/package.json ./apps/burn/
COPY apps/bursar/package.json ./apps/bursar/
COPY apps/bill/package.json ./apps/bill/
COPY apps/blank/package.json ./apps/blank/
COPY apps/blueprint/package.json ./apps/blueprint/
COPY apps/bin/package.json ./apps/bin/
COPY apps/bay/package.json ./apps/bay/
COPY apps/blip/package.json ./apps/blip/
COPY apps/bureau/package.json ./apps/bureau/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/
COPY packages/bureau-client/package.json ./packages/bureau-client/

RUN pnpm install --no-frozen-lockfile

# ── Stage: build ──────────────────────────────────────────────────
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/ui/ ./packages/ui/
COPY packages/bureau-client/ ./packages/bureau-client/

# Each SPA's full source is copied in ONE layer (src + public + index.html +
# tsconfig + vite.config; node_modules and dist are excluded by .dockerignore).
#
# IMPORTANT: this used to be FOUR COPY instructions per app (src, public,
# index.html, tsconfig+vite.config). With 24 SPAs that is ~96 layers, and added
# to the deps stage it pushed the build-stage layer chain past the overlayfs
# 128-layer maximum the moment the 24th SPA (bursar) landed - every frontend
# image build then failed with "max depth exceeded" at a COPY step. One COPY per
# app keeps the chain comfortably under the limit. Do NOT split these back into
# per-file COPYs; add new SPAs as a single `COPY apps/<app>/ ./apps/<app>/` line.
COPY apps/frontend/ ./apps/frontend/
COPY apps/helpdesk/ ./apps/helpdesk/
COPY apps/banter/ ./apps/banter/
COPY apps/beacon/ ./apps/beacon/
COPY apps/brief/ ./apps/brief/
COPY apps/bolt/ ./apps/bolt/
COPY apps/bearing/ ./apps/bearing/
COPY apps/board/ ./apps/board/
COPY apps/bond/ ./apps/bond/
COPY apps/blast/ ./apps/blast/
COPY apps/book/ ./apps/book/
COPY apps/bench/ ./apps/bench/
COPY apps/basis/ ./apps/basis/
COPY apps/braid/ ./apps/braid/
COPY apps/bulwark/ ./apps/bulwark/
COPY apps/burn/ ./apps/burn/
COPY apps/bursar/ ./apps/bursar/
COPY apps/bill/ ./apps/bill/
COPY apps/blank/ ./apps/blank/
COPY apps/blueprint/ ./apps/blueprint/
COPY apps/bin/ ./apps/bin/
COPY apps/bay/ ./apps/bay/
COPY apps/blip/ ./apps/blip/
COPY apps/bureau/ ./apps/bureau/

RUN pnpm --filter @bigbluebam/shared build \
 && pnpm --filter @bigbluebam/bureau-client build \
 && pnpm --filter @bigbluebam/frontend build \
 && pnpm --filter @bigbluebam/helpdesk build \
 && pnpm --filter @bigbluebam/banter build \
 && pnpm --filter @bigbluebam/beacon build \
 && pnpm --filter @bigbluebam/brief build \
 && pnpm --filter @bigbluebam/bolt build \
 && pnpm --filter @bigbluebam/bearing build \
 && pnpm --filter @bigbluebam/board build \
 && pnpm --filter @bigbluebam/bond build \
 && pnpm --filter @bigbluebam/blast build \
 && pnpm --filter @bigbluebam/book build \
 && pnpm --filter @bigbluebam/bench build \
 && pnpm --filter @bigbluebam/basis build \
 && pnpm --filter @bigbluebam/braid build \
 && pnpm --filter @bigbluebam/bulwark build \
 && pnpm --filter @bigbluebam/burn build \
 && pnpm --filter @bigbluebam/bursar build \
 && pnpm --filter @bigbluebam/bill build \
 && pnpm --filter @bigbluebam/blank build \
 && pnpm --filter @bigbluebam/blueprint build \
 && pnpm --filter @bigbluebam/bin build \
 && pnpm --filter @bigbluebam/bay build \
 && pnpm --filter @bigbluebam/blip build \
 && pnpm --filter @bigbluebam/bureau build

# ── Stage: production ────────────────────────────────────────────
FROM nginx:alpine AS production

COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html/b3
COPY --from=build /app/apps/helpdesk/dist /usr/share/nginx/html/helpdesk
COPY --from=build /app/apps/banter/dist /usr/share/nginx/html/banter
COPY --from=build /app/apps/beacon/dist /usr/share/nginx/html/beacon
COPY --from=build /app/apps/brief/dist /usr/share/nginx/html/brief
COPY --from=build /app/apps/bolt/dist /usr/share/nginx/html/bolt
COPY --from=build /app/apps/bearing/dist /usr/share/nginx/html/bearing
COPY --from=build /app/apps/board/dist /usr/share/nginx/html/board
COPY --from=build /app/apps/bond/dist /usr/share/nginx/html/bond
COPY --from=build /app/apps/blast/dist /usr/share/nginx/html/blast
COPY --from=build /app/apps/book/dist /usr/share/nginx/html/book
COPY --from=build /app/apps/bench/dist /usr/share/nginx/html/bench
COPY --from=build /app/apps/basis/dist /usr/share/nginx/html/basis
COPY --from=build /app/apps/braid/dist /usr/share/nginx/html/braid
COPY --from=build /app/apps/bulwark/dist /usr/share/nginx/html/bulwark
COPY --from=build /app/apps/burn/dist /usr/share/nginx/html/burn
COPY --from=build /app/apps/bursar/dist /usr/share/nginx/html/bursar
COPY --from=build /app/apps/bill/dist /usr/share/nginx/html/bill
COPY --from=build /app/apps/blank/dist /usr/share/nginx/html/blank
COPY --from=build /app/apps/blueprint/dist /usr/share/nginx/html/blueprint
COPY --from=build /app/apps/bin/dist /usr/share/nginx/html/bin
COPY --from=build /app/apps/bay/dist /usr/share/nginx/html/bay
COPY --from=build /app/apps/blip/dist /usr/share/nginx/html/blip
COPY --from=build /app/apps/bureau/dist /usr/share/nginx/html/bureau

# Documentation files for the in-app Help viewer (served at /docs/)
# These are the hand-authored and pipeline-generated markdown files.
# In docker-compose, a bind mount of ./docs/apps/ overlays this COPY
# so changes are visible without a rebuild.
COPY docs/apps/ /usr/share/nginx/html/docs/apps/

# Default profile-picture options (served at /avatars/, reachable from every
# SPA regardless of its base path). In docker-compose, a bind mount of
# ./assets/default-avatars overlays this COPY so newly-added avatars appear
# without a rebuild. User-uploaded avatars are served separately via /files/.
COPY assets/default-avatars/ /usr/share/nginx/html/avatars/

# Two nginx config profiles are baked into the image and the right one is
# picked at container start by infra/nginx/entrypoint.sh, which lives at
# /docker-entrypoint.d/ so the official nginx image runs it before starting
# the server.
#
#   default → infra/nginx/nginx.conf            (docker-compose / bare docker)
#   railway → infra/nginx/nginx.railway.conf    (uses *.railway.internal upstreams)
#
# Selection rule: if RAILWAY_ENVIRONMENT_NAME or RAILWAY_PROJECT_ID is set
# (Railway injects these on every service), use the railway profile;
# otherwise use the default profile. The compose flow continues to override
# whichever profile is selected because docker-compose.yml mounts
# infra/nginx/nginx-with-site.conf over default.conf at runtime.
COPY infra/nginx/nginx.conf /etc/nginx/profiles/default.conf
COPY infra/nginx/nginx.railway.conf /etc/nginx/profiles/railway.conf
COPY infra/nginx/entrypoint.sh /docker-entrypoint.d/00-pick-nginx-profile.sh
RUN chmod +x /docker-entrypoint.d/00-pick-nginx-profile.sh

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE

# Both nginx profiles are baked in. The default (docker-compose) profile
# binds port 80; the railway profile binds 8080 (picked by entrypoint via
# RAILWAY_ENVIRONMENT_NAME / RAILWAY_PROJECT_ID). Docker-compose ignores
# EXPOSE because its `ports:` directive maps explicitly, but Railway auto-
# detects targetPort from EXPOSE on fresh service/domain creation — so the
# value here MUST match the railway profile to avoid 502s on first deploy.
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
