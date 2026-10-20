import { exportCohubDebugLog } from "@neta-art/cohub/debugger";

const CFEED_ENDPOINT = "https://cfeed.neta.art/api/v1/feedback";
const CFEED_APP = "cohub";

// Mirrors cfeed's global defaults (5 files, 10 MB each, MIME allowlist).
export const FEEDBACK_MAX_FILES = 5;
export const FEEDBACK_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_MAX_CONTENT_CHARS = 10_000;
export const FEEDBACK_ACCEPT = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"video/mp4",
	"video/webm",
	"text/plain",
	"application/json",
	"application/pdf",
	"application/zip",
].join(",");

// Leave headroom under the per-file limit for multipart overhead.
const DEBUG_LOG_MAX_BYTES = 9 * 1024 * 1024;

export type FeedbackExtra = Record<string, unknown>;

export function isFeedbackFileAccepted(file: File) {
	return FEEDBACK_ACCEPT.split(",").includes(file.type);
}

export function createDebugLogFile(now = new Date()): File {
	const log = exportCohubDebugLog();
	let text = JSON.stringify(log);
	// Keep the newest entries when the ring buffers exceed the upload limit.
	while (
		new Blob([text]).size > DEBUG_LOG_MAX_BYTES &&
		(log.console.length > 0 || log.network.length > 0)
	) {
		const droppedConsole = Math.ceil(log.console.length / 2);
		const droppedNetwork = Math.ceil(log.network.length / 2);
		log.console = log.console.slice(droppedConsole);
		log.network = log.network.slice(droppedNetwork);
		log.dropped = {
			console: log.dropped.console + droppedConsole,
			network: log.dropped.network + droppedNetwork,
		};
		text = JSON.stringify(log);
	}
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
	return new File([text], `cohub-debug-${stamp}.json`, {
		type: "application/json",
	});
}

export async function submitFeedback(input: {
	content: string;
	extra: FeedbackExtra;
	files: File[];
}): Promise<{ id: string }> {
	const body = new FormData();
	body.set("app", CFEED_APP);
	body.set("content", input.content);
	body.set("extra", JSON.stringify(input.extra));
	for (const file of input.files) body.append("files", file, file.name);

	const response = await fetch(CFEED_ENDPOINT, { method: "POST", body });
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as {
			error?: { code?: string; message?: string };
		} | null;
		const message = payload?.error?.message ?? response.statusText;
		throw new Error(`Feedback upload failed (${response.status}): ${message}`);
	}
	return (await response.json()) as { id: string };
}
