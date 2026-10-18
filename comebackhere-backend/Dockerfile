# syntax=docker/dockerfile:1
#
# comebackhere-backend (Node) — multi-stage image
#
#   docker build -t comebackhere-backend comebackhere-backend/
#   docker run --rm -p 3000:3000 --env-file comebackhere-backend/.env comebackhere-backend
#
# Targets:
#   runtime (default) — compiled dist/ with production dependencies only.
#   dev               — full dependencies and sources, run via `tsx watch`.
#                      Selected by docker-compose.override.yml, which bind-mounts
#                      the working tree over /app and so cannot use a baked dist/.
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

# ── dev: full dependencies + source, run from source via tsx ──────────────────
# Used by docker-compose.override.yml, which bind-mounts the working tree over
# /app. That mount hides anything built into the image, so the dev stage cannot
# rely on a precompiled dist/ — it runs the sources directly instead.
FROM node:${NODE_VERSION}-alpine AS dev
ENV NODE_ENV=development \
    PORT=3000
WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=25s --retries=12 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

# `npm run dev` is `tsx watch src/index.ts`, so edits in the bind mount restart
# the server. Run node via npm here (unlike the runtime stage) because the
# watcher process manager, not node, owns the PID.
CMD ["npm", "run", "dev"]

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
