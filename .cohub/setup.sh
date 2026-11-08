#!/usr/bin/env bash
set -euo pipefail

git config --global checkout.workers 32
git config --global checkout.thresholdForParallelism 0
pnpm config set --location=global enable-global-virtual-store true

if [[ -n ${GITEA_NPM_TOKEN:-} ]]; then
  printf '%s\n' '//git.talesofai.com/api/packages/talesofai/npm/:_authToken=${GITEA_NPM_TOKEN}' > ~/.npmrc
fi
