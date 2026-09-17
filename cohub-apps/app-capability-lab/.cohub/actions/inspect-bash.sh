#!/usr/bin/env bash
set -euo pipefail

input="$(cat)"
space_id="${COHUB_SPACE_ID:-}"

space_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1] || null))' "$space_id")"
input_json="${input:-null}"

printf '{"ok":true,"action":"inspect-bash","runner":"bash","spaceId":%s,"input":%s}\n' \
  "$space_json" \
  "$input_json"
