# ── Stage: deps ───────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml* ./
COPY apps/mcp-server/package.json ./apps/mcp-server/
COPY packages/shared/package.json ./packages/shared/
COPY packages/permissions/package.json ./packages/permissions/

RUN pnpm install --no-frozen-lockfile

# ── Stage: build ──────────────────────────────────────────────────
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsup.config.ts ./packages/shared/
COPY packages/permissions/ ./packages/permissions/
COPY apps/mcp-server/src ./apps/mcp-server/src
COPY apps/mcp-server/tsconfig.json apps/mcp-server/tsup.config.ts ./apps/mcp-server/

RUN pnpm --filter @bigbluebam/shared build \
 && pnpm --filter @bigbluebam/permissions build \
 && pnpm --filter @bigbluebam/mcp-server build

RUN pnpm --filter @bigbluebam/mcp-server deploy --prod /app/deployed


# ── Stage: dev ────────────────────────────────────────────────────
FROM deps AS dev

COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/permissions/ ./packages/permissions/
COPY apps/mcp-server/ ./apps/mcp-server/

WORKDIR /app/apps/mcp-server

EXPOSE 3001

CMD ["npx", "tsx", "watch", "src/server.ts"]

# ── Stage: production ────────────────────────────────────────────
FROM node:22-alpine AS production

RUN apk add --no-cache tini curl

WORKDIR /app

RUN addgroup -g 1001 -S bbam \
 && adduser -S bbam -u 1001 -G bbam

COPY --from=build /app/deployed/node_modules ./node_modules
COPY --from=build /app/apps/mcp-server/dist ./dist
COPY --from=build /app/deployed/package.json ./

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE

RUN chown -R bbam:bbam /app

USER bbam

EXPOSE 3001

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server.js"]
