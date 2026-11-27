# -- Stage: deps ───────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml* ./
COPY apps/bill-api/package.json ./apps/bill-api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/auth-core/package.json ./packages/auth-core/
COPY packages/logging/package.json ./packages/logging/
COPY packages/service-health/package.json ./packages/service-health/
COPY packages/db-stubs/package.json ./packages/db-stubs/
COPY packages/permissions/package.json ./packages/permissions/
COPY packages/storage/package.json ./packages/storage/

RUN pnpm install --no-frozen-lockfile

# -- Stage: build ──────────────────────────────────────────────────
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsup.config.ts ./packages/shared/
COPY packages/auth-core/ ./packages/auth-core/
COPY packages/logging/ ./packages/logging/
COPY packages/service-health/ ./packages/service-health/
COPY packages/db-stubs/ ./packages/db-stubs/
COPY packages/permissions/ ./packages/permissions/
COPY packages/storage/ ./packages/storage/
COPY apps/bill-api/src ./apps/bill-api/src
COPY apps/bill-api/tsconfig.json apps/bill-api/tsup.config.ts ./apps/bill-api/

RUN pnpm --filter @bigbluebam/shared build \
 && pnpm --filter @bigbluebam/auth-core build \
 && pnpm --filter @bigbluebam/logging build \
 && pnpm --filter @bigbluebam/service-health build \
 && pnpm --filter @bigbluebam/db-stubs build \
 && pnpm --filter @bigbluebam/permissions build \
 && pnpm --filter @bigbluebam/storage build \
 && pnpm --filter @bigbluebam/bill-api build

# Create a deploy-ready directory with all prod deps
RUN pnpm --filter @bigbluebam/bill-api deploy --prod /app/deployed


# -- Stage: dev ────────────────────────────────────────────────────
FROM deps AS dev

COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/auth-core/ ./packages/auth-core/
COPY packages/logging/ ./packages/logging/
COPY packages/service-health/ ./packages/service-health/
COPY packages/db-stubs/ ./packages/db-stubs/
COPY packages/permissions/ ./packages/permissions/
COPY packages/storage/ ./packages/storage/
COPY apps/bill-api/ ./apps/bill-api/

WORKDIR /app/apps/bill-api

EXPOSE 4014

CMD ["npx", "tsx", "watch", "src/server.ts"]

# -- Stage: production ────────────────────────────────────────────
FROM node:22-alpine AS production

RUN apk add --no-cache tini curl

WORKDIR /app

RUN addgroup -g 1001 -S bbam \
 && adduser -S bbam -u 1001 -G bbam

COPY --from=build --chown=bbam:bbam /app/deployed/node_modules ./node_modules
COPY --from=build --chown=bbam:bbam /app/apps/bill-api/dist ./dist
COPY --from=build --chown=bbam:bbam /app/deployed/package.json ./
COPY infra/postgres/migrations/ ./migrations/

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE

# Ownership is set by COPY --chown above; a recursive chown would copy every
# node_modules file into a second layer (#198). Only /app itself needs it.
RUN chown bbam:bbam /app

USER bbam

EXPOSE 4014

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server.js"]
