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
FROM base AS runtime
ENV NODE_ENV=production
ENV DO_NOT_TRACK=1
WORKDIR /app

RUN groupadd -g 1001 app \
 && useradd -u 1001 -g app -s /usr/sbin/nologin -d /app app

COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --prod
COPY --from=builder /app/build ./build
COPY --from=builder /app/config ./config
COPY --from=builder /app/definitions ./definitions

RUN chown -R app:app /app
USER app

ARG VERSION
ENV VERSION=${VERSION}

EXPOSE 9000

CMD ["node", "--enable-source-maps", "build/bin/server.js"]
