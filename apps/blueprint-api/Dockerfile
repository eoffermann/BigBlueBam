# -- Stage: deps ───────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml* ./
COPY apps/blueprint-api/package.json ./apps/blueprint-api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/logging/package.json ./packages/logging/
COPY packages/service-health/package.json ./packages/service-health/
COPY packages/db-stubs/package.json ./packages/db-stubs/
COPY packages/permissions/package.json ./packages/permissions/

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
COPY apps/blueprint-api/src ./apps/blueprint-api/src
COPY apps/blueprint-api/tsconfig.json apps/blueprint-api/tsup.config.ts ./apps/blueprint-api/

RUN pnpm --filter @bigbluebam/shared build \
 && pnpm --filter @bigbluebam/logging build \
 && pnpm --filter @bigbluebam/service-health build \
 && pnpm --filter @bigbluebam/db-stubs build \
 && pnpm --filter @bigbluebam/permissions build \
 && pnpm --filter @bigbluebam/blueprint-api build

# Create a deploy-ready directory with all prod deps
RUN pnpm --filter @bigbluebam/blueprint-api deploy --prod /app/deployed


# -- Stage: dev ────────────────────────────────────────────────────
FROM deps AS dev

COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/logging/ ./packages/logging/
COPY packages/service-health/ ./packages/service-health/
COPY packages/db-stubs/ ./packages/db-stubs/
COPY packages/permissions/ ./packages/permissions/
COPY apps/blueprint-api/ ./apps/blueprint-api/

WORKDIR /app/apps/blueprint-api

EXPOSE 4015

CMD ["npx", "tsx", "watch", "src/server.ts"]

# -- Stage: production ────────────────────────────────────────────
FROM node:22-alpine AS production

RUN apk add --no-cache tini curl

WORKDIR /app

RUN addgroup -g 1001 -S bbam \
 && adduser -S bbam -u 1001 -G bbam

COPY --from=build /app/deployed/node_modules ./node_modules
COPY --from=build /app/apps/blueprint-api/dist ./dist
COPY --from=build /app/deployed/package.json ./
COPY infra/postgres/migrations/ ./migrations/

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE

RUN chown -R bbam:bbam /app

USER bbam

EXPOSE 4015

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server.js"]
