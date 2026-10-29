import {
	UPLOAD_ERROR_FILE_TOO_LARGE,
	UPLOAD_ERROR_RATE_LIMITED,
	UPLOAD_MAX_FILE_BYTES,
} from "@cohub/protocol";
import { formatByteLimit } from "$lib/format-bytes";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

/** A direct PUT to object storage failed; `status` is 0 when the connection dropped. */
export class UploadTransferError extends Error {
	override name = "UploadTransferError";
	readonly status: number;
	constructor(status: number) {
		super(
			status ? `Upload failed (${status})` : "Upload failed: network error",
		);
		this.status = status;
	}
}

export const uploadFileLimitLabel = () =>
	formatByteLimit(UPLOAD_MAX_FILE_BYTES);

export const exceedsUploadFileLimit = (file: Blob) =>
	file.size > UPLOAD_MAX_FILE_BYTES;

/** The structured fields an SDK `HttpError` carries from an api rejection. */
type CodedError = { code?: unknown; body?: { retryAfterSeconds?: unknown } };

function retryAfterMinutes(error: CodedError) {
	const seconds = error.body?.retryAfterSeconds;
	return typeof seconds === "number" && seconds > 0
		? Math.ceil(seconds / 60)
		: null;
}

/**
 * Localized reason for a failed upload, or null when nothing is more specific
 * than "upload failed". Server messages stay English and are never shown here.
 */
export function describeUploadError(
	error: unknown,
	locale: Locale,
): string | null {
	if (error instanceof UploadTransferError)
		return error.status === 0 ? m.upload_error_network({}, { locale }) : null;
	if (error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError"))
		return m.upload_error_network({}, { locale });
	if (typeof error !== "object" || error === null) return null;
	const coded = error as CodedError;
	if (coded.code === UPLOAD_ERROR_FILE_TOO_LARGE)
		return m.upload_error_file_too_large(
			{ limit: uploadFileLimitLabel() },
			{ locale },
		);
	if (coded.code === UPLOAD_ERROR_RATE_LIMITED) {
		const minutes = retryAfterMinutes(coded);
		return minutes
			? m.upload_error_rate_limited({ minutes }, { locale })
			: m.upload_error_rate_limited_soon({}, { locale });
	}
	return null;
}
