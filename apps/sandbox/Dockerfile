# syntax=docker/dockerfile:1.7

ARG GO_VERSION=1.27.2
ARG CHROME_VERSION=155.0.8059.84
ARG BUN_VERSION=1.4.3
ARG PNPM_VERSION=12.10.1

FROM golang:${GO_VERSION}-bookworm AS builder

WORKDIR /app

COPY go.mod go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/cohub-sandbox .

# Pinned so unchanged layers keep their digests across releases; bump deliberately.
FROM node:26-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG GO_VERSION
ARG CHROME_VERSION
ARG BUN_VERSION
ARG PNPM_VERSION

ENV DEBIAN_FRONTEND=noninteractive
ENV WORKSPACE_DIR=/workspace
ENV PLATFORM_AGENTS_DIR=/configs/platform/.agents

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    tini \
    curl git wget ca-certificates openssh-client \
    iputils-ping iproute2 bind9-dnsutils \
    file unzip zip \
    python3 python3-pip python3-venv python3-dev python3-numpy \
    ffmpeg imagemagick libimage-exiftool-perl \
    xvfb xauth at-spi2-core dbus-daemon \
    libgl1 libegl1 \
    vim tree tmux htop xz-utils less \
    build-essential \
    strace lsof \
    fonts-noto-cjk fonts-noto-color-emoji fonts-freefont-ttf \
    bash procps \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 \
    libgtk-3-0t64 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0t64 \
    libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 libxrender1 \
    libasound2t64 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 \
    libnspr4 libatk-bridge2.0-0t64 libdrm2 libxkbcommon0 libatspi2.0-0t64 \
    libcups2t64 libxshmfence1 libgbm1 \
    && ln -sf /usr/bin/python3 /usr/bin/python

RUN set -eux; \
    mkdir -p /opt/chrome-for-testing; \
    curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" -o /tmp/chrome-linux64.zip; \
    unzip -q /tmp/chrome-linux64.zip -d /opt/chrome-for-testing; \
    rm /tmp/chrome-linux64.zip; \
    ln -sf /opt/chrome-for-testing/chrome-linux64/chrome /usr/local/bin/google-chrome; \
    google-chrome --version

RUN curl -fsSL https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-unknown-linux-gnu.tar.gz | tar xz --wildcards -C /usr/local/bin --strip-components=1 '*/fd' \
 && curl -fsSL https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz | tar xz --wildcards -C /usr/local/bin --strip-components=1 '*/rg' \
 && curl -fsSL https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-linux-amd64 -o /usr/local/bin/jq \
 && chmod +x /usr/local/bin/fd /usr/local/bin/rg /usr/local/bin/jq

RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar xz -C /usr/local

ENV HOME=/home/node
ENV BUN_INSTALL=/home/node/.bun
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PIP_USER=true
ENV PATH="/usr/local/go/bin:/home/node/.bun/bin:${NPM_CONFIG_PREFIX}/bin:/home/node/.local/bin:/home/node/go/bin:/home/node/.pnpm-global/bin:${PATH}"

# Avoid a recursive chown layer duplicating installed tooling.
USER node

RUN mkdir -p /home/node/.npm-global /home/node/.local /home/node/go/bin /home/node/.pnpm-global/bin

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000,sharing=locked \
    npm install -g pnpm@${PNPM_VERSION}

# Bump this token to re-resolve npm latest on manual rebuilds.
ARG COHUB_CLI_REFRESH=0
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000,sharing=locked \
    echo "cohub-cli refresh token: ${COHUB_CLI_REFRESH}" \
 && npm install -g typescript tsx @neta-art/cohub-cli@latest

USER root

WORKDIR /app

RUN install -d -o node -g node "$WORKSPACE_DIR"

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/cohub/internal/cohub-sandbox"]

FROM base AS game
USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG GODOT_VERSION=4.5.2
ARG GODOT_SHA512=e3ce6194b6d4d2dcef5e5b5136752c084d9d8b9071c10bc2d2011b947ec7439a257c8d23c541cb30699f16d9edea6dff36e6e84d2bec14a8fe9b4e9aacbe5a8d
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    blender cmake ninja-build pkg-config \
    libgl1-mesa-dri mesa-utils \
    libvulkan1 mesa-vulkan-drivers vulkan-tools \
    libsdl2-dev libgl-dev libegl-dev
RUN set -eux; \
    archive="Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip"; \
    url="https://github.com/godotengine/godot-builds/releases/download/${GODOT_VERSION}-stable"; \
    curl -fsSL "$url/$archive" -o "/tmp/$archive"; \
    printf '%s  %s\n' "$GODOT_SHA512" "/tmp/$archive" | sha512sum --check --strict -; \
    unzip "/tmp/$archive" -d /opt/godot; \
    ln -s "/opt/godot/Godot_v${GODOT_VERSION}-stable_linux.x86_64" /usr/local/bin/godot; \
    rm "/tmp/$archive"
USER node
# The binary changes every release; keep it last so game layers stay cached.
COPY LICENSE NOTICE /opt/cohub/
COPY --from=builder /out/cohub-sandbox /opt/cohub/internal/cohub-sandbox

FROM base AS runtime
COPY LICENSE NOTICE /opt/cohub/
COPY --from=builder /out/cohub-sandbox /opt/cohub/internal/cohub-sandbox
