# Build context: repo root (npm workspaces).
# Built via .github/workflows/deploy-api.yml with context=. file=apps/api/Dockerfile

# ── Stage 1: Install dependencies ──
FROM node:22-alpine AS deps
WORKDIR /app
# Workspace lockfile + manifests for the api workspace and its deps
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/api/package.json ./apps/api/
# Drop --ignore-scripts so sharp downloads the correct alpine binary
# and npm creates .bin symlinks for tsc/prisma (used by the builder stage).
RUN npm ci --workspace=apps/api --include-workspace-root

# ── Stage 2: Build TypeScript ──
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN npm run db:generate --workspace=apps/api && \
    npm run build --workspace=apps/api

# ── Stage 3: Production image ──
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg && \
    addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser

COPY --from=builder /app/node_modules ./node_modules
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
