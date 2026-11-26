# -- Stage: deps ───────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml* ./
COPY apps/bastion-api/package.json ./apps/bastion-api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/logging/package.json ./packages/logging/
COPY packages/service-health/package.json ./packages/service-health/
COPY packages/db-stubs/package.json ./packages/db-stubs/
COPY packages/permissions/package.json ./packages/permissions/
COPY packages/storage/package.json ./packages/storage/
COPY packages/structured-data/package.json ./packages/structured-data/

RUN pnpm install --no-frozen-lockfile

# -- Stage: build ──────────────────────────────────────────────────
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsup.config.ts ./packages/shared/
COPY packages/logging/ ./packages/logging/
COPY packages/service-health/ ./packages/service-health/
COPY packages/db-stubs/ ./packages/db-stubs/
COPY packages/permissions/ ./packages/permissions/
COPY packages/storage/ ./packages/storage/
COPY packages/structured-data/ ./packages/structured-data/
COPY apps/bastion-api/src ./apps/bastion-api/src
COPY apps/bastion-api/tsconfig.json apps/bastion-api/tsup.config.ts ./apps/bastion-api/

RUN pnpm --filter @bigbluebam/shared build \
 && pnpm --filter @bigbluebam/logging build \
 && pnpm --filter @bigbluebam/service-health build \
 && pnpm --filter @bigbluebam/db-stubs build \
 && pnpm --filter @bigbluebam/permissions build \
 && pnpm --filter @bigbluebam/storage build \
 && pnpm --filter @bigbluebam/structured-data build \
 && pnpm --filter @bigbluebam/bastion-api build

# Create a deploy-ready directory with all prod deps
RUN pnpm --filter @bigbluebam/bastion-api deploy --prod /app/deployed


# -- Stage: dev ────────────────────────────────────────────────────
FROM deps AS dev

COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/logging/ ./packages/logging/
COPY packages/service-health/ ./packages/service-health/
COPY packages/db-stubs/ ./packages/db-stubs/
COPY packages/permissions/ ./packages/permissions/
COPY packages/storage/ ./packages/storage/
COPY packages/structured-data/ ./packages/structured-data/
COPY apps/bastion-api/ ./apps/bastion-api/

WORKDIR /app/apps/bastion-api

EXPOSE 4024

CMD ["npx", "tsx", "watch", "src/server.ts"]

# -- Stage: production ────────────────────────────────────────────
FROM node:22-alpine AS production

RUN apk add --no-cache tini curl

WORKDIR /app

RUN addgroup -g 1001 -S bbam \
 && adduser -S bbam -u 1001 -G bbam

# COPY --chown instead of a trailing `RUN chown -R`: a recursive chown rewrites every
# node_modules file into a second layer (doubling the image's node_modules) and takes over
# an hour on slow Docker disks. Only /app itself still needs a (non-recursive) chown.
COPY --from=build --chown=bbam:bbam /app/deployed/node_modules ./node_modules
COPY --from=build --chown=bbam:bbam /app/apps/bastion-api/dist ./dist
COPY --from=build --chown=bbam:bbam /app/deployed/package.json ./

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE

RUN chown bbam:bbam /app

USER bbam

EXPOSE 4024

# tini forwards SIGTERM so the 75 s drain (stop_grace_period) reaches node.
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server.js"]
