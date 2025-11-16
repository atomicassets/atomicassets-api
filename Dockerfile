# Use shared base image with Node.js, pnpm, and workspace dependencies pre-installed
# Base image includes: node:22-alpine, pnpm 10.21.0, workspace deps, shared packages
FROM local/atomichub-base

# Copy service-specific code
COPY --chown=application:application apps/eosio-contract-api ./apps/eosio-contract-api

# Install service dependencies
RUN pnpm install --frozen-lockfile --filter "@atomichub/eosio-contract-api"

# Build service (if build script exists)
RUN pnpm --filter "@atomichub/eosio-contract-api" run build || true

# Set working directory to service
WORKDIR /home/application/app/apps/eosio-contract-api

ARG VERSION
ENV NODE_ENV=production
ENV VERSION=${VERSION}

EXPOSE 9000

CMD ["pnpm", "start"]
