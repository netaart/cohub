#!/usr/bin/env bash
set -euo pipefail
if [[ "$GITHUB_REF_TYPE" == tag ]]; then
  VERSION="${GITHUB_REF_NAME#v}"
  git fetch --no-tags origin main
  git merge-base --is-ancestor HEAD origin/main
fi
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo 'Expected a stable X.Y.Z marketing version' >&2
  exit 1
fi
echo "VERSION=$VERSION" >> "$GITHUB_ENV"
