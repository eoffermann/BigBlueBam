# ── Stage: deps ───────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml* ./
COPY apps/banter-api/package.json ./apps/banter-api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/logging/package.json ./packages/logging/
COPY packages/service-health/package.json ./packages/service-health/
COPY packages/db-stubs/package.json ./packages/db-stubs/
COPY packages/livekit-tokens/package.json ./packages/livekit-tokens/
COPY packages/permissions/package.json ./packages/permissions/

RUN pnpm install --no-frozen-lockfile

# ── Stage: build ──────────────────────────────────────────────────
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsup.config.ts ./packages/shared/
COPY packages/logging/ ./packages/logging/
COPY packages/service-health/ ./packages/service-health/
COPY packages/db-stubs/ ./packages/db-stubs/
COPY packages/livekit-tokens/ ./packages/livekit-tokens/
COPY packages/permissions/ ./packages/permissions/
COPY apps/banter-api/src ./apps/banter-api/src
COPY apps/banter-api/tsconfig.json apps/banter-api/tsup.config.ts ./apps/banter-api/

RUN pnpm --filter @bigbluebam/shared build \
 && pnpm --filter @bigbluebam/logging build \
 && pnpm --filter @bigbluebam/service-health build \
 && pnpm --filter @bigbluebam/db-stubs build \
 && pnpm --filter @bigbluebam/livekit-tokens build \
 && pnpm --filter @bigbluebam/permissions build \
 && pnpm --filter @bigbluebam/banter-api build

# Create a deploy-ready directory with all prod deps
RUN pnpm --filter @bigbluebam/banter-api deploy --prod /app/deployed


# ── Stage: dev ────────────────────────────────────────────────────
FROM deps AS dev

COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/logging/ ./packages/logging/
COPY packages/service-health/ ./packages/service-health/
COPY packages/db-stubs/ ./packages/db-stubs/
COPY packages/livekit-tokens/ ./packages/livekit-tokens/
COPY packages/permissions/ ./packages/permissions/
COPY apps/banter-api/ ./apps/banter-api/

WORKDIR /app/apps/banter-api

EXPOSE 4002

CMD ["npx", "tsx", "watch", "src/server.ts"]


# ── Stage: production ────────────────────────────────────────────
FROM node:22-alpine AS production

RUN apk add --no-cache tini curl

WORKDIR /app

RUN addgroup -g 1001 -S bbam \
 && adduser -S bbam -u 1001 -G bbam

COPY --from=build /app/deployed/node_modules ./node_modules
COPY --from=build /app/apps/banter-api/dist ./dist
COPY --from=build /app/deployed/package.json ./

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE

RUN chown -R bbam:bbam /app

USER bbam

EXPOSE 4002

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server.js"]
