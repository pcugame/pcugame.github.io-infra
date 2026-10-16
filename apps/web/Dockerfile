# Build context: repository root. No Node/npm is needed on the serving host.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
RUN npm ci
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
ENV VITE_RUNTIME_CONFIG=true VITE_BASE_PATH=/ VITE_MOCK=false VITE_DEV_AUTH_ENABLED=false
RUN npm run build --workspace=apps/web

FROM docker.io/library/nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
ARG RELEASE_SOURCE_SHA
LABEL org.opencontainers.image.revision="${RELEASE_SOURCE_SHA}"
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
