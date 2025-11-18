# Turbo Prune Dockerfile - Optimized 3-stage build
# Stage 1: Prepare - Prune monorepo for specific service
FROM node:22-alpine AS prepare

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files for dependency installation
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY turbo.json ./

# Install all dependencies including turbo (from lockfile)
RUN pnpm install --frozen-lockfile=true

# Copy entire monorepo for pruning
COPY . .

# Prune to create minimal workspace for this service
RUN pnpm exec turbo prune @atomichub/eosio-contract-api --docker

# Stage 2: Builder - Install dependencies, type check, and build
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

# Create application user
RUN adduser --disabled-password application && \
  mkdir -p /home/application/app && \
  chown -R application:application /home/application

USER application
WORKDIR /home/application/app

# Copy pruned package.json files (for dependency installation)
# This layer is cached unless lockfile changes
COPY --from=prepare --chown=application:application /app/out/json/ .

# Install dependencies (cached unless lockfile changes)
RUN pnpm install --frozen-lockfile=true

# Copy pruned source code and build configuration
COPY --from=prepare --chown=application:application /app/out/full/ .


# Build the service (already type-checked)
RUN pnpm turbo run build --filter="@atomichub/eosio-contract-api..."

# Stage 3: Runtime - Production image
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@latest --activate

# Create application user
RUN adduser --disabled-password application && \
  mkdir -p /home/application/app && \
  chown -R application:application /home/application

USER application
WORKDIR /home/application/app

# Copy built application from builder
COPY --from=builder --chown=application:application /home/application/app .

# NOTE: Stay at monorepo root - don't change WORKDIR to apps/eosio-contract-api
# This allows services to find config files using relative paths like ../config/config.json

ARG VERSION
ENV NODE_ENV=production
ENV VERSION=${VERSION}

EXPOSE 9000

# Run service directly with node (keeps CWD at /home/application/app where configs are mounted)
# Default: server (for filler use: apps/eosio-contract-api/build/src/bin/filler.js, for abiscan: apps/eosio-contract-api/build/src/bin/abiscan.js)
CMD ["node", "apps/eosio-contract-api/build/src/bin/server.js"]
