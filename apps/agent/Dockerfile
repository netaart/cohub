# syntax=docker/dockerfile:1.4

FROM node:26-slim AS base
WORKDIR /app
COPY package.json ./
RUN npm install -g "$(node -p 'require("./package.json").packageManager')" && rm package.json

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
COPY packages/media/package.json ./packages/media/package.json
COPY packages/media/tsconfig.json ./packages/media/tsconfig.json
COPY packages/media/tsconfig.build.json ./packages/media/tsconfig.build.json
COPY packages/model-runtime/package.json ./packages/model-runtime/package.json
COPY packages/model-runtime/tsconfig.json ./packages/model-runtime/tsconfig.json
COPY packages/model-runtime/tsconfig.build.json ./packages/model-runtime/tsconfig.build.json
COPY packages/sandbox-controller/package.json ./packages/sandbox-controller/package.json
COPY packages/sandbox-controller/tsconfig.json ./packages/sandbox-controller/tsconfig.json
COPY packages/sandbox-controller/tsconfig.build.json ./packages/sandbox-controller/tsconfig.build.json
COPY packages/sandbox-client/package.json ./packages/sandbox-client/package.json
COPY packages/sandbox-client/tsconfig.json ./packages/sandbox-client/tsconfig.json
COPY packages/sandbox-client/tsconfig.build.json ./packages/sandbox-client/tsconfig.build.json
COPY apps/agent/package.json ./apps/agent/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  --mount=type=secret,id=gitea_npm_token \
  GITEA_NPM_TOKEN="$(cat /run/secrets/gitea_npm_token 2>/dev/null || true)" && \
  export GITEA_NPM_TOKEN && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    printf '\n//git.talesofai.com/api/packages/talesofai/npm/:_authToken=%s\n' "$GITEA_NPM_TOKEN" >> /root/.npmrc; \
  fi && \
  pnpm config set store-dir /pnpm/store && \
  pnpm install --frozen-lockfile --ignore-scripts --filter @cohub/agent... && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    if [ -n "$GITEA_NPM_TOKEN" ]; then sed -i '/git.talesofai.com\/api\/packages\/talesofai\/npm\/:_authToken=/d' /root/.npmrc; fi; \
  fi

COPY packages/protocol ./packages/protocol
COPY packages/billing ./packages/billing
COPY packages/infra ./packages/infra
COPY packages/db ./packages/db
COPY packages/core ./packages/core
COPY packages/media ./packages/media
COPY packages/model-runtime ./packages/model-runtime
COPY packages/sandbox-controller ./packages/sandbox-controller
COPY packages/sandbox-client ./packages/sandbox-client
COPY apps/agent/src ./apps/agent/src
COPY apps/agent/scripts ./apps/agent/scripts
COPY apps/agent/tsconfig.json apps/agent/tsconfig.build.json ./apps/agent/

RUN pnpm --filter @cohub/agent... build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  --mount=type=secret,id=gitea_npm_token \
  GITEA_NPM_TOKEN="$(cat /run/secrets/gitea_npm_token 2>/dev/null || true)" && \
  export GITEA_NPM_TOKEN && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    printf '\n//git.talesofai.com/api/packages/talesofai/npm/:_authToken=%s\n' "$GITEA_NPM_TOKEN" >> /root/.npmrc; \
  fi && \
  pnpm --filter @cohub/agent --prod deploy /prod/agent && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    if [ -n "$GITEA_NPM_TOKEN" ]; then sed -i '/git.talesofai.com\/api\/packages\/talesofai\/npm\/:_authToken=/d' /root/.npmrc; fi; \
  fi

FROM node:26-slim AS runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size-percentage=75
ENV WORKSPACE_ROOT=/space-storage
ENV SESSIONS_DIR=/sessions
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && apt-get clean \
  && curl -fsSL https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-unknown-linux-gnu.tar.gz \
    | tar xz --wildcards -C /usr/local/bin --strip-components=1 '*/fd' \
  && curl -fsSL https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz \
    | tar xz --wildcards -C /usr/local/bin --strip-components=1 '*/rg' \
  && chmod +x /usr/local/bin/fd /usr/local/bin/rg

COPY --from=builder --chown=node:node /prod/agent ./
COPY --chown=node:node LICENSE NOTICE ./
RUN mkdir -p "$WORKSPACE_ROOT" "$SESSIONS_DIR" && chown -R node:node "$WORKSPACE_ROOT" "$SESSIONS_DIR"

USER node
CMD ["node", "dist/index.js"]
