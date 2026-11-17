# syntax=docker/dockerfile:1.7
# Owner: Agent H. Builds the React app (apps/web, Agent E) to static files and serves them with Caddy,
# which also terminates TLS and reverse-proxies /api to the api container.
#   docker build -f infra/docker/web.Dockerfile -t kansview/sms-web:dev .
ARG NODE_IMAGE=node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
ARG CADDY_IMAGE=caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@sms/web..."
COPY packages/ packages/
COPY apps/web/ apps/web/
# The production bundle never contains MSW mocks (Agent E guards them behind import.meta.env.DEV / VITE_USE_MOCKS).
ENV VITE_USE_MOCKS=false
RUN pnpm --filter "@sms/web^..." build && pnpm --filter @sms/web build

FROM ${CADDY_IMAGE} AS runtime
# Caddy runs as an unprivileged user on high ports (8080/8443); Compose maps host 80/443 to them.
# /data (certificates, internal CA) and /config are the only writable paths (named volumes).
RUN mkdir -p /data /config /srv/www \
 && chown -R 10001:10001 /data /config
COPY --chown=root:root infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build --chown=root:root /repo/apps/web/dist/ /srv/www/
ARG SMS_APP_VERSION=dev
LABEL org.opencontainers.image.title="kansview-sms-web" org.opencontainers.image.version="${SMS_APP_VERSION}"
USER 10001:10001
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8081/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
