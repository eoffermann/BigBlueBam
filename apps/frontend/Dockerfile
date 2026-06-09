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
COPY apps/bill/package.json ./apps/bill/
COPY apps/blank/package.json ./apps/blank/
COPY apps/blueprint/package.json ./apps/blueprint/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/

RUN pnpm install --no-frozen-lockfile

# ── Stage: build ──────────────────────────────────────────────────
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsup.config.ts ./packages/shared/

# Shared UI components (resolved via Vite aliases)
COPY packages/ui/ ./packages/ui/

# BBB frontend
COPY apps/frontend/src ./apps/frontend/src
COPY apps/frontend/public ./apps/frontend/public
COPY apps/frontend/index.html ./apps/frontend/
COPY apps/frontend/tsconfig.json apps/frontend/tsconfig.node.json apps/frontend/vite.config.ts ./apps/frontend/

# Helpdesk frontend
COPY apps/helpdesk/src ./apps/helpdesk/src
COPY apps/helpdesk/public ./apps/helpdesk/public
COPY apps/helpdesk/index.html ./apps/helpdesk/
COPY apps/helpdesk/tsconfig.json apps/helpdesk/tsconfig.node.json apps/helpdesk/vite.config.ts ./apps/helpdesk/

# Banter frontend
COPY apps/banter/src ./apps/banter/src
COPY apps/banter/public ./apps/banter/public
COPY apps/banter/index.html ./apps/banter/
COPY apps/banter/tsconfig.json apps/banter/tsconfig.node.json apps/banter/vite.config.ts ./apps/banter/

# Beacon frontend
COPY apps/beacon/src ./apps/beacon/src
COPY apps/beacon/public ./apps/beacon/public
COPY apps/beacon/index.html ./apps/beacon/
COPY apps/beacon/tsconfig.json apps/beacon/tsconfig.node.json apps/beacon/vite.config.ts ./apps/beacon/

# Brief frontend
COPY apps/brief/src ./apps/brief/src
COPY apps/brief/public ./apps/brief/public
COPY apps/brief/index.html ./apps/brief/
COPY apps/brief/tsconfig.json apps/brief/tsconfig.node.json apps/brief/vite.config.ts ./apps/brief/

# Bolt frontend
COPY apps/bolt/src ./apps/bolt/src
COPY apps/bolt/public ./apps/bolt/public
COPY apps/bolt/index.html ./apps/bolt/
COPY apps/bolt/tsconfig.json apps/bolt/tsconfig.node.json apps/bolt/vite.config.ts ./apps/bolt/

# Bearing frontend
COPY apps/bearing/src ./apps/bearing/src
COPY apps/bearing/public ./apps/bearing/public
COPY apps/bearing/index.html ./apps/bearing/
COPY apps/bearing/tsconfig.json apps/bearing/tsconfig.node.json apps/bearing/vite.config.ts ./apps/bearing/

# Board frontend
COPY apps/board/src ./apps/board/src
COPY apps/board/public ./apps/board/public
COPY apps/board/index.html ./apps/board/
COPY apps/board/tsconfig.json apps/board/tsconfig.node.json apps/board/vite.config.ts ./apps/board/

# Bond frontend
COPY apps/bond/src ./apps/bond/src
COPY apps/bond/public ./apps/bond/public
COPY apps/bond/index.html ./apps/bond/
COPY apps/bond/tsconfig.json apps/bond/tsconfig.node.json apps/bond/vite.config.ts ./apps/bond/

# Blast frontend
COPY apps/blast/src ./apps/blast/src
COPY apps/blast/public ./apps/blast/public
COPY apps/blast/index.html ./apps/blast/
COPY apps/blast/tsconfig.json apps/blast/tsconfig.node.json apps/blast/vite.config.ts ./apps/blast/

# Book frontend
COPY apps/book/src ./apps/book/src
COPY apps/book/public ./apps/book/public
COPY apps/book/index.html ./apps/book/
COPY apps/book/tsconfig.json apps/book/tsconfig.node.json apps/book/vite.config.ts ./apps/book/

# Bench frontend
COPY apps/bench/src ./apps/bench/src
COPY apps/bench/public ./apps/bench/public
COPY apps/bench/index.html ./apps/bench/
COPY apps/bench/tsconfig.json apps/bench/tsconfig.node.json apps/bench/vite.config.ts ./apps/bench/

# Bill frontend
COPY apps/bill/src ./apps/bill/src
COPY apps/bill/public ./apps/bill/public
COPY apps/bill/index.html ./apps/bill/
COPY apps/bill/tsconfig.json apps/bill/tsconfig.node.json apps/bill/vite.config.ts ./apps/bill/

# Blank frontend
COPY apps/blank/src ./apps/blank/src
COPY apps/blank/public ./apps/blank/public
COPY apps/blank/index.html ./apps/blank/
COPY apps/blank/tsconfig.json apps/blank/tsconfig.node.json apps/blank/vite.config.ts ./apps/blank/

# Blueprint frontend
COPY apps/blueprint/src ./apps/blueprint/src
COPY apps/blueprint/public ./apps/blueprint/public
COPY apps/blueprint/index.html ./apps/blueprint/
COPY apps/blueprint/tsconfig.json apps/blueprint/tsconfig.node.json apps/blueprint/vite.config.ts ./apps/blueprint/

RUN pnpm --filter @bigbluebam/shared build \
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
 && pnpm --filter @bigbluebam/bill build \
 && pnpm --filter @bigbluebam/blank build \
 && pnpm --filter @bigbluebam/blueprint build

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
COPY --from=build /app/apps/bill/dist /usr/share/nginx/html/bill
COPY --from=build /app/apps/blank/dist /usr/share/nginx/html/blank
COPY --from=build /app/apps/blueprint/dist /usr/share/nginx/html/blueprint

# Documentation files for the in-app Help viewer (served at /docs/)
# These are the hand-authored and pipeline-generated markdown files.
# In docker-compose, a bind mount of ./docs/apps/ overlays this COPY
# so changes are visible without a rebuild.
COPY docs/apps/ /usr/share/nginx/html/docs/apps/

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
