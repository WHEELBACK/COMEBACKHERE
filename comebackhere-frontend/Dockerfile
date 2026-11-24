# syntax=docker/dockerfile:1
#
# comebackhere-frontend (React/Vite) — multi-stage image
#
#   docker build -t comebackhere-frontend comebackhere-frontend/
#   docker run --rm -p 5173:5173 comebackhere-frontend
#
# The Vite dev server is what docker-compose runs, so the image targets local
# development parity: source is mounted over /app by the compose override and
# the server restarts on change. There is no lockfile in this repo, so installs
# fall back to `npm install`.
#
# `--host 0.0.0.0` is required: Vite binds to loopback by default, which is
# unreachable from outside the container.

ARG NODE_VERSION=20

# ── deps ──────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi \
  && npm cache clean --force

# ── dev: full source + node_modules, so a bind mount does not shadow deps ─────
FROM node:${NODE_VERSION}-alpine AS dev
ENV NODE_ENV=development
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

EXPOSE 5173

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD wget -qO- "http://127.0.0.1:5173/" > /dev/null || exit 1

# Bind to all interfaces so the port published by docker-compose is reachable.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
