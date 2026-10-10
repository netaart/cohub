# syntax=docker/dockerfile:1.7

FROM golang:1.24-bookworm AS builder

WORKDIR /app

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/cohub-sandbox .

FROM node:26-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV WORKSPACE_DIR=/workspace
ENV PLATFORM_AGENTS_DIR=/configs/platform/.agents

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    curl git wget ca-certificates openssh-client \
    iputils-ping iproute2 bind9-dnsutils \
    file unzip zip \
    python3 python3-pip python3-venv python3-dev \
    ffmpeg imagemagick libimage-exiftool-perl \
    xvfb at-spi2-core dbus-daemon \
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
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install Chrome for Testing as a system browser so tools like agent-browser can
# discover it via PATH, independent of the runtime user's home directory.
RUN set -eux; \
    CHROME_VERSION="$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json \
      | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); console.log(j.channels.Stable.version)})")"; \
    CHROME_URL="https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip"; \
    mkdir -p /opt/chrome-for-testing; \
    curl -fsSL "$CHROME_URL" -o /tmp/chrome-linux64.zip; \
    unzip -q /tmp/chrome-linux64.zip -d /opt/chrome-for-testing; \
    rm /tmp/chrome-linux64.zip; \
    ln -sf /opt/chrome-for-testing/chrome-linux64/chrome /usr/local/bin/google-chrome; \
    google-chrome --version

RUN curl -fsSL https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-unknown-linux-gnu.tar.gz | tar xz --wildcards -C /usr/local/bin --strip-components=1 '*/fd' \
 && curl -fsSL https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz | tar xz --wildcards -C /usr/local/bin --strip-components=1 '*/rg' \
 && curl -fsSL https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-linux-amd64 -o /usr/local/bin/jq \
 && chmod +x /usr/local/bin/fd /usr/local/bin/rg /usr/local/bin/jq

RUN ln -sf /usr/bin/python3 /usr/bin/python

ENV BUN_INSTALL=/home/node/.bun
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PIP_USER=true
ENV PATH="/home/node/.bun/bin:${NPM_CONFIG_PREFIX}/bin:/home/node/.local/bin:/home/node/go/bin:/home/node/.pnpm-global/bin:${PATH}"

RUN curl -fsSL https://bun.sh/install | bash
RUN npm install -g pnpm@12.10.1

# Resolve the latest cohub-cli at install time (intentionally unpinned so the
# image always tracks the npm "latest" dist-tag). Docker caches this layer by
# instruction text, so pass a unique COHUB_CLI_REFRESH (e.g. a timestamp) to
# bust the cache and force npm to re-resolve latest on rebuild.
ARG COHUB_CLI_REFRESH=0
RUN echo "cohub-cli refresh token: ${COHUB_CLI_REFRESH}" \
 && npm install -g typescript tsx @neta-art/cohub-cli@latest
RUN mkdir -p /home/node/.npm-global /home/node/.bun /home/node/.local /home/node/go/bin /home/node/.pnpm-global/bin \
    && chown -R node:node /home/node/.npm-global /home/node/.bun /home/node/.local /home/node/go /home/node/.pnpm-global

RUN curl -fsSL https://go.dev/dl/go1.24.13.linux-amd64.tar.gz | tar xz -C /usr/local
ENV PATH="/usr/local/go/bin:${PATH}"

WORKDIR /app

COPY --from=builder /out/cohub-sandbox /opt/cohub/internal/cohub-sandbox
COPY LICENSE NOTICE /opt/cohub/

RUN mkdir -p "$WORKSPACE_DIR"
RUN chown -R node:node "$WORKSPACE_DIR" 2>/dev/null || true

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/cohub/internal/cohub-sandbox"]
