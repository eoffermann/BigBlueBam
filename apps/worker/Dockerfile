# ── Stage: deps ───────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml* ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/
COPY packages/smtp-resolver/package.json ./packages/smtp-resolver/

RUN pnpm install --no-frozen-lockfile

# ── Stage: build ──────────────────────────────────────────────────
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsup.config.ts ./packages/shared/
COPY packages/smtp-resolver/ ./packages/smtp-resolver/
COPY apps/worker/src ./apps/worker/src
COPY apps/worker/tsconfig.json apps/worker/tsup.config.ts ./apps/worker/

RUN pnpm --filter @bigbluebam/shared build \
 && pnpm --filter @bigbluebam/smtp-resolver build \
 && pnpm --filter @bigbluebam/worker build

RUN pnpm --filter @bigbluebam/worker deploy --prod /app/deployed


# ── Stage: dev ────────────────────────────────────────────────────
FROM deps AS dev

# ffmpeg/ffprobe for the bin-transcode job (media proxies + posters);
# postgresql16-client (pg_dump/pg_restore) for the database backup/restore jobs.
RUN apk add --no-cache ffmpeg postgresql16-client

COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/smtp-resolver/ ./packages/smtp-resolver/
COPY apps/worker/ ./apps/worker/

WORKDIR /app/apps/worker

CMD ["npx", "tsx", "watch", "src/worker.ts"]

# ── Stage: production ────────────────────────────────────────────
FROM node:22-alpine AS production

# tini+curl for PID1/healthcheck; ffmpeg/ffprobe for the bin-transcode job;
# postgresql16-client (pg_dump/pg_restore) for the database backup/restore jobs.
RUN apk add --no-cache tini curl ffmpeg postgresql16-client

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
