# Build context: repo root (npm workspaces).
# Built via .github/workflows/deploy-api.yml with context=. file=apps/api/Dockerfile

# ── Stage 1: Install dependencies ──
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Workspace lockfile + manifests for the api workspace and its deps
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/api/package.json ./apps/api/
# Install workspace deps. Keep lifecycle scripts enabled so sharp's
# platform-specific optional dep (@img/sharp-linux-x64) is selected by
# npm for this Debian/glibc build host — same libc as the runner stage.
RUN npm ci --workspace=apps/api --include-workspace-root

# ── Stage 2: Build TypeScript ──
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
# Workspace-scoped bins (prisma, tsc) live here, not hoisted to root node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
RUN npm run db:generate --workspace=apps/api && \
    npm run build --workspace=apps/api

# ── Stage 3: Production image ──
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg wget && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup --no-create-home --shell /usr/sbin/nologin appuser

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/packages/contracts ./packages/contracts
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
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

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
