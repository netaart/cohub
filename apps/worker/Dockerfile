# syntax=docker/dockerfile:1.4
# Cohub Worker Dockerfile
# BullMQ worker + Node.js runtime - Multi-stage build with pnpm deploy

# ============================================
# Base: common build tooling
# ============================================
FROM node:24-slim AS base

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate


# ============================================
# Stage 1: build workspace and deploy portable app
# ============================================
FROM base AS builder

COPY .npmrc pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/protocol/tsconfig.json ./packages/protocol/tsconfig.json
COPY packages/protocol/tsconfig.build.json ./packages/protocol/tsconfig.build.json
COPY packages/billing/package.json ./packages/billing/package.json
COPY packages/billing/tsconfig.json ./packages/billing/tsconfig.json
COPY packages/billing/tsconfig.build.json ./packages/billing/tsconfig.build.json
COPY packages/infra/package.json ./packages/infra/package.json
COPY packages/infra/tsconfig.json ./packages/infra/tsconfig.json
COPY packages/infra/tsconfig.build.json ./packages/infra/tsconfig.build.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/tsconfig.json ./packages/db/tsconfig.json
COPY packages/db/tsconfig.build.json ./packages/db/tsconfig.build.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/core/tsconfig.json ./packages/core/tsconfig.json
COPY packages/core/tsconfig.build.json ./packages/core/tsconfig.build.json
COPY packages/model-runtime/package.json ./packages/model-runtime/package.json
COPY packages/model-runtime/tsconfig.json ./packages/model-runtime/tsconfig.json
COPY packages/model-runtime/tsconfig.build.json ./packages/model-runtime/tsconfig.build.json
COPY packages/sandbox-controller/package.json ./packages/sandbox-controller/package.json
COPY packages/sandbox-controller/tsconfig.json ./packages/sandbox-controller/tsconfig.json
COPY packages/sandbox-controller/tsconfig.build.json ./packages/sandbox-controller/tsconfig.build.json
COPY apps/worker/package.json ./apps/worker/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  --mount=type=secret,id=gitea_npm_token \
  GITEA_NPM_TOKEN="$(cat /run/secrets/gitea_npm_token 2>/dev/null || true)" && \
  export GITEA_NPM_TOKEN && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    printf '\n//git.talesofai.com/api/packages/talesofai/npm/:_authToken=%s\n' "$GITEA_NPM_TOKEN" >> /root/.npmrc; \
  fi && \
  pnpm config set store-dir /pnpm/store && \
  pnpm install --frozen-lockfile --ignore-scripts --filter @cohub/worker... && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    if [ -n "$GITEA_NPM_TOKEN" ]; then sed -i '/git.talesofai.com\/api\/packages\/talesofai\/npm\/:_authToken=/d' /root/.npmrc; fi; \
  fi

# Copy source and build
COPY packages/protocol ./packages/protocol
COPY packages/billing ./packages/billing
COPY packages/infra ./packages/infra
COPY packages/db ./packages/db
COPY packages/core ./packages/core
COPY packages/model-runtime ./packages/model-runtime
COPY packages/sandbox-controller ./packages/sandbox-controller
COPY apps/worker/src ./apps/worker/src
COPY apps/worker/tsconfig.json apps/worker/tsconfig.build.json ./apps/worker/

RUN pnpm --filter @cohub/worker... build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  --mount=type=secret,id=gitea_npm_token \
  GITEA_NPM_TOKEN="$(cat /run/secrets/gitea_npm_token 2>/dev/null || true)" && \
  export GITEA_NPM_TOKEN && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    printf '\n//git.talesofai.com/api/packages/talesofai/npm/:_authToken=%s\n' "$GITEA_NPM_TOKEN" >> /root/.npmrc; \
  fi && \
  pnpm --filter @cohub/worker --prod deploy /prod/worker && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    if [ -n "$GITEA_NPM_TOKEN" ]; then sed -i '/git.talesofai.com\/api\/packages\/talesofai\/npm\/:_authToken=/d' /root/.npmrc; fi; \
  fi

# Pinned Linux amd64 binary (the worker image's supported deployment platform).
FROM node:24-slim AS pdu
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
  curl -fsSL --retry 3 https://github.com/KSXGitHub/parallel-disk-usage/releases/download/0.24.0/pdu-x86_64-unknown-linux-musl -o /usr/local/bin/pdu && \
  echo 'b991a68c1555d9144ea8ef2dd8cab91efb0b90ec8be53fdec4d0b2dd0e596f56  /usr/local/bin/pdu' | sha256sum -c - && \
  chmod 755 /usr/local/bin/pdu

# ============================================
# Stage 2: runtime
# ============================================
FROM node:24-slim AS runtime

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /prod/worker ./
COPY --from=pdu /usr/local/bin/pdu /usr/local/bin/pdu
COPY LICENSE NOTICE ./
COPY apps/worker/licenses/pdu-LICENSE ./licenses/pdu-LICENSE

USER node

CMD ["node", "dist/index.js"]
