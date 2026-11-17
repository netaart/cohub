#!/usr/bin/env bash
set -euo pipefail
artifact="${1:?Usage: upload.sh IPA_OR_PKG}"
test -f "$artifact"
test -n "${APP_STORE_CONNECT_KEY_ID:?App Store Connect key ID is required}"
test -n "${APP_STORE_CONNECT_KEY_P8:?App Store Connect private key is required}"
umask 077
keys="$(mktemp -d "$RUNNER_TEMP/cohub-upload.XXXXXX")"
trap 'rm -rf "$keys"' EXIT
printf '%s' "$APP_STORE_CONNECT_KEY_P8" > "$keys/AuthKey_$APP_STORE_CONNECT_KEY_ID.p8"
export API_PRIVATE_KEYS_DIR="$keys"
args=(--api-key "$APP_STORE_CONNECT_KEY_ID")
if [[ -n "${APP_STORE_CONNECT_ISSUER_ID:-}" ]]; then
  args+=(--api-issuer "$APP_STORE_CONNECT_ISSUER_ID")
else
  args+=(--api-key-subject user)
fi
case "$artifact" in *.ipa) platform=ios ;; *.pkg) platform=macos ;; *) echo "Expected an IPA or PKG" >&2; exit 1 ;; esac
xcrun altool --validate-app "$artifact" --platform "$platform" "${args[@]}"
xcrun altool --upload-package "$artifact" --platform "$platform" "${args[@]}"
