import { exportCohubDebugLog } from "@neta-art/cohub/debugger";

const CFEED_ENDPOINT = "https://cfeed.neta.art/api/v1/feedback";
const CFEED_APP = "cohub";

// Our own budget for the auto-attached log; cfeed enforces its limits server-side.
const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;

export type FeedbackExtra = Record<string, unknown>;

export function createDebugLogFile(now = new Date()): File {
	const log = exportCohubDebugLog();
	let text = JSON.stringify(log);
	// Keep the newest entries when the ring buffers exceed the budget.
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
}): Promise<void> {
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
		throw new Error(
			payload?.error?.message ?? `${response.status} ${response.statusText}`,
		);
	}
}
