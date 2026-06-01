# ── Stage: deps ───────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml* ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install --no-frozen-lockfile

# ── Stage: build ──────────────────────────────────────────────────
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsup.config.ts ./packages/shared/
COPY apps/worker/src ./apps/worker/src
COPY apps/worker/tsconfig.json apps/worker/tsup.config.ts ./apps/worker/

RUN pnpm --filter @bigbluebam/shared build \
 && pnpm --filter @bigbluebam/worker build

RUN pnpm --filter @bigbluebam/worker deploy --prod /app/deployed


# ── Stage: production ────────────────────────────────────────────
FROM node:22-alpine AS production

RUN apk add --no-cache tini curl

WORKDIR /app

RUN addgroup -g 1001 -S bbam \
 && adduser -S bbam -u 1001 -G bbam

COPY --from=build /app/deployed/node_modules ./node_modules
COPY --from=build /app/apps/worker/dist ./dist
COPY --from=build /app/deployed/package.json ./

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE

RUN chown -R bbam:bbam /app

USER bbam

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/worker.js"]
