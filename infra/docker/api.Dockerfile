# syntax=docker/dockerfile:1.7
# Owner: Agent H. Image for the API, the background worker and the one-shot migration job.
#   docker build -f infra/docker/api.Dockerfile -t kansview/sms-api:dev .
# The same image runs three ways (see infra/compose/docker-compose.yml):
#   api     -> node docker-entrypoint.mjs api
#   worker  -> node docker-entrypoint.mjs worker
#   migrate -> node docker-entrypoint.mjs migrate
#
# Base image pinned by exact tag AND digest. Renovate/dependency-scan workflow proposes bumps.
ARG NODE_IMAGE=node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

# ---------- build stage: install all deps, compile shared packages and the API ----------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
# Manifests first so the dependency layer is cached between code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db-types/package.json packages/db-types/
COPY db/package.json db/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@sms/api..." --filter "@sms/db"
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY db/ db/
RUN pnpm --filter "@sms/api^..." build && pnpm --filter @sms/api build
# Production-only node_modules with workspace packages copied in (no symlinks back to /repo).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @sms/api deploy --legacy --prod /out \
 && mkdir -p /out/db && cp -r db/tools db/migrations /out/db/ \
 && rm -rf /out/src /out/test /out/*.tsbuildinfo

# ---------- runtime stage: no compilers, no package manager, non-root, read-only friendly ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    SMS_NODE_ENV=production \
    TZ=Africa/Accra \
    SMS_PORT=3000 \
    SMS_FILE_STORAGE_DIR=/var/lib/sms/storage \
    SMS_BACKUP_STATUS_DIR=/var/lib/sms/backup-status \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
# Application files are owned by root and not writable by the runtime user.
COPY --from=build --chown=root:root /out/ /app/
COPY --chown=root:root infra/docker/api-entrypoint.mjs /app/docker-entrypoint.mjs
# Writable paths are volumes/tmpfs mounted at runtime; create mount points owned by the node user (uid 1000).
RUN mkdir -p /var/lib/sms/storage /var/lib/sms/backup-status \
 && chown -R node:node /var/lib/sms/storage \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ARG SMS_APP_VERSION=dev
ENV SMS_APP_VERSION=${SMS_APP_VERSION}
LABEL org.opencontainers.image.title="kansview-sms-api" org.opencontainers.image.version="${SMS_APP_VERSION}"
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "/app/docker-entrypoint.mjs", "healthcheck"]
ENTRYPOINT ["node", "/app/docker-entrypoint.mjs"]
CMD ["api"]
