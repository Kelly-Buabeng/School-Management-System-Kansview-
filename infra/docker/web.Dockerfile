# syntax=docker/dockerfile:1.7
# Owner: Agent H. Builds the React app (apps/web, Agent E) to static files and serves them with Caddy,
# which also terminates TLS and reverse-proxies /api to the api container.
#   docker build -f infra/docker/web.Dockerfile -t kansview/sms-web:dev .
ARG NODE_IMAGE=node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
ARG CADDY_IMAGE=caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
# Caddy is rebuilt from source (infra/caddy-build) with a patched Go toolchain and golang.org/x/net,
# because the upstream 2.11.9 image ships Go 1.27.3 and x/net 0.60.0 (HIGH: CVE-2026-97054, CVE-2026-78661).
# When upstream publishes a fixed image, this stage can be dropped.
ARG GO_IMAGE=golang:1.27.4-alpine3.24@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280

FROM ${GO_IMAGE} AS caddy-build
WORKDIR /src
COPY infra/caddy-build/ ./
RUN --mount=type=cache,id=go-mod,target=/go/pkg/mod --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export SSL_CERT_FILE=/run/secrets/extra_ca; fi \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/caddy . \
 && /out/caddy version

FROM ${NODE_IMAGE} AS build
# Optional build secret "extra_ca": a CA bundle for networks with a TLS-inspecting proxy
#   docker build --secret id=extra_ca,src=/path/ca.pem ...   (absent = normal public CAs)
ENV PNPM_HOME=/pnpm CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store --mount=type=secret,id=extra_ca,required=false \
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
COPY --from=caddy-build --chown=root:root /out/caddy /usr/bin/caddy
COPY --chown=root:root infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build --chown=root:root /repo/apps/web/dist/ /srv/www/
ARG SMS_APP_VERSION=dev
LABEL org.opencontainers.image.title="kansview-sms-web" org.opencontainers.image.version="${SMS_APP_VERSION}"
USER 10001:10001
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8081/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
