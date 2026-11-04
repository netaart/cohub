---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Spaces can set a like sticker, an image that replaces the heart on their published Apps. `SpacePublicProfile.likeSticker` carries it as `{ url }`, `space(id).profile({ likeSticker })` sets or clears it, and the `space_like_sticker` upload purpose takes WebP, PNG or GIF up to `LIKE_STICKER_MAX_FILE_BYTES`. The CLI adds `cohub spaces like-sticker <path>` and `--clear`, and `spaces get` shows the sticker.
