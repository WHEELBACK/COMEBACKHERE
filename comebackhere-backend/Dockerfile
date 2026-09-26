# syntax=docker/dockerfile:1
#
# comebackhere-backend (Node) — multi-stage image
#
#   docker build -t comebackhere-backend comebackhere-backend/
#   docker run --rm -p 3000:3000 --env-file comebackhere-backend/.env comebackhere-backend
#
# package-lock.json is gitignored in this repo, so installs use `npm ci` when a
# lockfile is present in the build context and fall back to `npm install`.

ARG NODE_VERSION=20

# ── deps: production dependencies only ────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force

# ── builder: full dependencies + TypeScript compile ───────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── runtime: dist/ + production node_modules, non-root ────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=deps    --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The official image ships an unprivileged `node` user (uid 1000).
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

# Run node directly (not via npm) so SIGTERM reaches the app's graceful
# shutdown handler, which drains webhooks within SHUTDOWN_TIMEOUT_MS.
CMD ["node", "dist/index.js"]
