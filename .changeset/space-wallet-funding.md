---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Space wallets accept funding from guests: hosts can turn on public funding, contributors pay a tier online or move purchased personal balance in whole dollars, and failed transfers return automatically. Adds `wallet.funding()`, `wallet.transfer()`, `wallet.getTransfer()`, `createOrder({ returnPath })`, and `profile({ fundingEnabled })`; the CLI gains `spaces wallet funding|transfer|transfer-status|public-funding`, and `--request-id` is now optional.
