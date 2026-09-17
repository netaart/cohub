#!/usr/bin/env bash
# Commerce setup for 課金殿 — The Whale Shrine
# Creates a $5 credit product that grants 1 "whale_offering" credit per purchase.
#
# Usage:
#   COHUB_SPACE_ID=<space-id> bash commerce-setup.sh
#   # or
#   bash commerce-setup.sh -s <space-id>

set -euo pipefail

SPACE_ID="${COHUB_SPACE_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s) SPACE_ID="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$SPACE_ID" ]]; then
  echo "Usage: COHUB_SPACE_ID=<id> bash $0  OR  bash $0 -s <id>"
  exit 1
fi

echo "→ Setting up commerce on space $SPACE_ID ..."

cohub -s "$SPACE_ID" spaces commerce setup

echo "→ Creating credit benefit: Whale Offering (1 credit) ..."
cohub -s "$SPACE_ID" spaces commerce benefits create \
  --type credits \
  --name "Whale Offering" \
  --amount 1 \
  --benefit-key whale_offering

echo "→ Creating product: Burn One Offering (\$5) ..."
cohub -s "$SPACE_ID" spaces commerce products create \
  --name "Burn One Offering" \
  --amount-usd 5 \
  --visibility public \
  --status active \
  --product-key burn_one_offering

echo "→ Binding product to benefit ..."
cohub -s "$SPACE_ID" spaces commerce bind \
  --product-key burn_one_offering \
  --benefit-key whale_offering

echo ""
echo "✓ Done. Verify with:"
echo "  cohub -s $SPACE_ID spaces commerce products list"
echo "  cohub -s $SPACE_ID spaces commerce benefits list"
