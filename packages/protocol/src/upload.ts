/**
 * Upload limits — the single source of truth shared by api, gateway, worker,
 * web and cli.
 *
 * Durable uploads (space files, public files, chat/app attachments, avatars,
 * gateway attachments) differ only by object-key prefix and materialization
 * destination, so they share one set of caps. Inline uploads never touch
 * object storage and are bounded by process memory or websocket frames instead.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// ── Durable object-storage uploads ────────────────────────────────────────────

/** Maximum size of a single uploaded file. */
export const UPLOAD_MAX_FILE_BYTES = 1 * GiB;
/** Maximum combined size of one upload batch. */
export const UPLOAD_MAX_BATCH_BYTES = 2 * GiB;
/** Maximum file count of one upload batch. */
export const UPLOAD_MAX_BATCH_FILES = 2000;

// ── Avatars (image-only, shared quota applies) ─────────────────────────────────

export const AVATAR_MAX_FILE_BYTES = 4 * MiB;

// ── Inline uploads (memory-bound) ─────────────────────────────────────────────

/** Direct multipart upload into a cloud sandbox workspace. */
export const INLINE_UPLOAD_MAX_FILE_BYTES = 64 * MiB;
export const INLINE_UPLOAD_MAX_FILES = 50;
/** Local sandboxes relay base64 over websocket frames capped at 50 MiB. */
export const LOCAL_SANDBOX_UPLOAD_MAX_FILE_BYTES = 32 * MiB;
/** Inline JSON/base64 file write through the fs API. */
export const INLINE_WRITE_MAX_BYTES = 10 * MiB;

// ── Per-user upload quota (fixed window) ──────────────────────────────────────

export const UPLOAD_RATE_WINDOW_SECONDS = 60 * 60;
export const UPLOAD_RATE_MAX_FILES = 5_000;
export const UPLOAD_RATE_MAX_BYTES = 10 * GiB;
