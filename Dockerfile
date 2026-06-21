# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable

# Stage 1: install full deps + build
FROM base AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Stage 2: runtime image with prod-only deps
# The node:bookworm-slim base ships a `node` user at uid 1000 - reuse it
# instead of creating a custom user, and set WORKDIR to /home/node/app to
# match the runtime config path expectations in src/bin/*.ts (which require
# config files from /home/node/app/config/).
FROM base AS runtime
ENV NODE_ENV=production
ENV DO_NOT_TRACK=1
WORKDIR /home/node/app

COPY --from=builder --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --prod \
 && chown -R node:node /home/node/app
COPY --from=builder --chown=node:node /app/build ./build
COPY --from=builder --chown=node:node /app/config ./config
COPY --from=builder --chown=node:node /app/definitions ./definitions
# Filler optional contract handlers (e.g. alien.worlds). The ModuleLoader at
# src/filler/modules.ts:24 requires `<repo>/modules/<name>.js` for each name
# listed in the chain's readers.config.json. Modules are hand-written
# CommonJS, not a build artifact - copy them as-is.
COPY --from=builder --chown=node:node /app/modules ./modules

USER node

ARG VERSION
ENV VERSION=${VERSION}

EXPOSE 9000

CMD ["node", "--enable-source-maps", "build/bin/server.js"]
