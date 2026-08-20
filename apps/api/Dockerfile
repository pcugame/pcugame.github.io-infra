# Build context: repo root (npm workspaces).
# Built via .github/workflows/deploy-api.yml with context=. file=apps/api/Dockerfile

# ── Stage 1: Install dependencies ──
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# openssl CLI is required at install time so @prisma/engines' postinstall
# detects OpenSSL 3.0.x and downloads the matching engines. Without it,
# detection silently falls back to debian-openssl-1.1.x and the runtime
# fails on bookworm with "Can't write to @prisma/engines" at migrate time.
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*
# Copy every workspace manifest so `npm ci` at the root installs all of
# them in one shot. Using `--workspace=apps/api` is tempting for image
# size, but npm (v10) silently skips platform-specific optional deps
# (@img/sharp-linux-x64, @napi-rs/canvas-linux-x64-gnu, ...) when a
# workspace filter is active — sharp then fails to load at runtime with
# "Could not load the sharp module using the linux-x64 runtime".
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN npm ci
# npm workspace installs can place sharp and its platform-specific optional
# packages at different node_modules levels. Install the Linux runtime pair
# directly so they land in /app/node_modules/@img/, where the hoisted sharp
# module will find the matching binary and libvips at runtime.
RUN npm install --no-save \
      @img/sharp-linux-x64@0.35.3 \
      @img/sharp-libvips-linux-x64@1.3.2

# ── Stage 2: Build TypeScript ──
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
# Workspace-scoped bins (prisma, tsc) live here, not hoisted to root node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
RUN npm run build --workspace=@pcu/contracts && \
    npm run db:generate --workspace=apps/api && \
    npm run build --workspace=apps/api

# ── Stage 3: Production image ──
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg wget openssl && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup --no-create-home --shell /usr/sbin/nologin appuser

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/packages/contracts ./packages/contracts
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
# The cutover audit is intentionally executed as an explicit, read-only
# pre-migration step by server/deploy.sh. Keep its source dependencies in the
# image; the server CMD itself must never migrate before that gate.
COPY --from=builder /app/apps/api/scripts ./apps/api/scripts
COPY --from=builder /app/apps/api/src ./apps/api/src
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/package.json ./

RUN npm install -g tsx && \
    mkdir -p /app/storage/protected /app/storage/public && \
    chown -R appuser:appgroup /app/storage

USER appuser

WORKDIR /app/apps/api

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/health || exit 1

CMD ["node", "dist/server.js"]
