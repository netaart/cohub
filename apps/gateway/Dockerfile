# syntax=docker/dockerfile:1.4

FROM node:26-slim AS base
WORKDIR /app
COPY package.json ./
RUN npm install -g "$(node -p 'require("./package.json").packageManager')" && rm package.json

FROM base AS builder

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
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

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store && \
  pnpm install --frozen-lockfile --ignore-scripts --filter @cohub/gateway...

COPY packages/identity ./packages/identity
COPY packages/protocol ./packages/protocol
COPY packages/infra ./packages/infra
COPY packages/media ./packages/media
COPY apps/gateway/src ./apps/gateway/src
COPY apps/gateway/tsconfig.json apps/gateway/tsconfig.build.json ./apps/gateway/

RUN pnpm --filter @cohub/gateway... build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm --filter @cohub/gateway --prod deploy /prod/gateway

FROM node:26-slim AS runtime

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size-percentage=75

WORKDIR /app

COPY --from=builder /prod/gateway ./
COPY LICENSE NOTICE ./

USER node

EXPOSE 8788

CMD ["node", "dist/index.js"]
