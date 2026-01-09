# syntax=docker/dockerfile:1.4
# Turbo Prune Dockerfile - Optimized 3-stage build with BuildKit cache mounts
# USAGE: Copy to apps/<service-name>/Dockerfile and replace:
#   - @atomichub/eosio-contract-api with actual service package name (e.g., @atomichub/config-service)
#   - apps/eosio-contract-api with actual service directory (e.g., apps/config-service)
#   - Port number (default 9000)

# Stage 1: Prepare - Prune monorepo for specific service
FROM 7wcqzqv2.c1.va1.container-registry.ovh.us/dhi-cache/node:22-debian13-sfw-dev AS prepare

# DHI production image - create app directory
USER root
RUN mkdir -p /home/nonroot/app && chown nonroot:nonroot /home/nonroot/app

WORKDIR /app

# Copy only files needed for turbo prune (minimal context)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY turbo.json ./

# Copy package.json files for all workspaces (needed for dependency graph)
# This is much lighter than copying entire source code
COPY apps/*/package.json apps/
COPY packages/*/package.json packages/

# Install only turbo CLI with proper env vars (lightweight, just for pruning)
# IMPORTANT: PNPM_HOME must be set for global installs
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
  export PNPM_HOME="/root/.local/share/pnpm" && \
  export PATH="$PNPM_HOME:$PATH" && \
  pnpm add -g turbo

# Copy only the specific service source (needed for turbo prune to analyze)
COPY apps/eosio-contract-api ./apps/eosio-contract-api

# Copy shared packages source (needed for dependency resolution)
COPY packages ./packages

# Set ENV for global pnpm packages
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Prune to create minimal workspace for this service
RUN turbo prune @atomichub/eosio-contract-api --docker

# Stage 2: Builder - Install dependencies and build
FROM 7wcqzqv2.c1.va1.container-registry.ovh.us/dhi-cache/node:22-debian13-sfw-dev AS builder

# DHI production image - create app directory
USER root
RUN mkdir -p /home/nonroot/app && chown nonroot:nonroot /home/nonroot/app

USER nonroot
WORKDIR /home/nonroot/app

# Copy pruned package.json files
COPY --from=prepare --chown=nonroot:nonroot /app/out/json/ .

# Copy workspace packages source BEFORE install (needed for pnpm workspace links)
COPY --from=prepare --chown=nonroot:nonroot /app/out/full/packages/ ./packages/

# Install dependencies from pruned workspace with cache mount
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,uid=65532,gid=65532 \
  pnpm install --frozen-lockfile=true

# Copy pruned source code
COPY --from=prepare --chown=nonroot:nonroot /app/out/full/ .

# Build the service with cache mount for turbo cache
RUN --mount=type=cache,target=/home/nonroot/app/.turbo-cache,uid=65532,gid=65532 \
  pnpm turbo run build --filter="@atomichub/eosio-contract-api..." --cache-dir=.turbo-cache

# Stage 3: Runtime - Production image
FROM 7wcqzqv2.c1.va1.container-registry.ovh.us/dhi-cache/node:22-debian13-sfw AS runtime

# DHI production image - create app directory
USER root
RUN mkdir -p /home/nonroot/app && chown nonroot:nonroot /home/nonroot/app

USER nonroot
WORKDIR /home/nonroot/app

# Copy built application from builder
COPY --from=builder --chown=nonroot:nonroot /home/nonroot/app .

# NOTE: Stay at monorepo root - don't change WORKDIR to apps/eosio-contract-api
# This allows services to find config files using relative paths like ../config/config.json

ARG VERSION
# Disable telemetry
ENV DO_NOT_TRACK=1

ENV NODE_ENV=production
ENV VERSION=${VERSION}

EXPOSE 9000

# Run service from its directory so ./definitions paths work, but configs are still at /home/nonroot/app/config
CMD ["sh", "-c", "cd apps/eosio-contract-api && node --enable-source-maps build/bin/server.js"]
