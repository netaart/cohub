# syntax=docker/dockerfile:1.4
# Cohub Gateway Dockerfile
# Multi-stage build with pnpm deploy

# ============================================
# Base: common build tooling
# ============================================
FROM node:24-slim AS base

WORKDIR /app

RUN corepack enable


# ============================================
# Stage 1: build workspace and deploy portable app
# ============================================
FROM base AS builder

COPY .npmrc pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/identity/package.json ./packages/identity/package.json
COPY packages/identity/tsconfig.json ./packages/identity/tsconfig.json
COPY packages/identity/tsconfig.build.json ./packages/identity/tsconfig.build.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/protocol/tsconfig.json ./packages/protocol/tsconfig.json
COPY packages/protocol/tsconfig.build.json ./packages/protocol/tsconfig.build.json
COPY packages/infra/package.json ./packages/infra/package.json
COPY packages/infra/tsconfig.json ./packages/infra/tsconfig.json
COPY packages/infra/tsconfig.build.json ./packages/infra/tsconfig.build.json
COPY packages/media/package.json ./packages/media/package.json
COPY packages/media/tsconfig.json ./packages/media/tsconfig.json
COPY packages/media/tsconfig.build.json ./packages/media/tsconfig.build.json
COPY apps/gateway/package.json ./apps/gateway/package.json

# Install full deps (build needs dev deps like typescript)
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  --mount=type=secret,id=gitea_npm_token \
  GITEA_NPM_TOKEN="$(cat /run/secrets/gitea_npm_token 2>/dev/null || true)" && \
  export GITEA_NPM_TOKEN && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    printf '\n//git.talesofai.com/api/packages/talesofai/npm/:_authToken=%s\n' "$GITEA_NPM_TOKEN" >> /root/.npmrc; \
  fi && \
  pnpm config set store-dir /pnpm/store && \
  pnpm install --frozen-lockfile --ignore-scripts --filter @cohub/gateway... && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    if [ -n "$GITEA_NPM_TOKEN" ]; then sed -i '/git.talesofai.com\/api\/packages\/talesofai\/npm\/:_authToken=/d' /root/.npmrc; fi; \
  fi

COPY packages/identity ./packages/identity
COPY packages/protocol ./packages/protocol
COPY packages/infra ./packages/infra
COPY packages/media ./packages/media
COPY apps/gateway/src ./apps/gateway/src
COPY apps/gateway/tsconfig.json apps/gateway/tsconfig.build.json ./apps/gateway/

RUN pnpm --filter @cohub/gateway... build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  --mount=type=secret,id=gitea_npm_token \
  GITEA_NPM_TOKEN="$(cat /run/secrets/gitea_npm_token 2>/dev/null || true)" && \
  export GITEA_NPM_TOKEN && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    printf '\n//git.talesofai.com/api/packages/talesofai/npm/:_authToken=%s\n' "$GITEA_NPM_TOKEN" >> /root/.npmrc; \
  fi && \
  pnpm --filter @cohub/gateway --prod deploy /prod/gateway && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    if [ -n "$GITEA_NPM_TOKEN" ]; then sed -i '/git.talesofai.com\/api\/packages\/talesofai\/npm\/:_authToken=/d' /root/.npmrc; fi; \
  fi

# ============================================
# Stage 2: runtime
# ============================================
FROM node:24-slim AS runtime

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size-percentage=75

WORKDIR /app

COPY --from=builder /prod/gateway ./
COPY LICENSE NOTICE ./

# Run as non-root
USER node

EXPOSE 8788

CMD ["node", "dist/index.js"]
