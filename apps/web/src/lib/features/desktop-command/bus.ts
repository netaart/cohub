import type {
	DesktopCommand,
	DesktopCommandDispatchedPayload,
} from "@neta-art/cohub";
import { getClientInstanceId } from "$lib/client-instance";

const loadSdk = async () => (await import("$lib/sdk")).sdk;

export type DesktopCommandOutcome =
	| { status: "pending" }
	| {
			status:
				| "applied"
				| "desktop_host_unavailable"
				| "rejected"
				| "unsupported";
			error?: { code: string; message: string };
	  };

type TerminalDesktopCommandOutcome = Exclude<
	DesktopCommandOutcome,
	{ status: "pending" }
>;

export type DesktopCommandContext = {
	commandId: string;
	source: DesktopCommandDispatchedPayload["source"];
};

export type DesktopCommandHost = (
	command: DesktopCommand,
	context: DesktopCommandContext,
) => Promise<DesktopCommandOutcome>;

const HOST_UNAVAILABLE: TerminalDesktopCommandOutcome = {
	status: "desktop_host_unavailable",
	error: {
		code: "desktop_host_unavailable",
		message:
			"This Cohub tab is not showing a Space workspace that can host the preview.",
	},
};

let host: DesktopCommandHost | null = null;

/**
 * The entry exists before the command runs, so a redelivery does not execute it
 * twice, and the outcome is kept so a failed upload can be re-reported. In memory
 * by design: delivery is at-least-once, so callable methods should be repeatable.
 */
type HandledEntry =
	| { state: "running" | "delegated" | "dropped" }
	| {
			state: "done";
			outcome: TerminalDesktopCommandOutcome;
			reported: boolean;
	  };
const handled = new Map<string, HandledEntry>();

const HANDLED_MAX = 200;
const HANDLED_KEEP = 100;
const UNREPORTED_MAX = 50;
const ATTEMPTS = 3;
let retryMs = 400;

const isUnreported = (entry: HandledEntry) =>
	entry.state === "done" && !entry.reported;

/** A running command is never evicted, or a redelivery would run it again. */
function evictBounded() {
	let unreported = 0;
	for (const entry of handled.values()) {
		if (isUnreported(entry)) unreported += 1;
	}

	for (const [id, entry] of handled) {
		if (handled.size <= HANDLED_KEEP && unreported <= UNREPORTED_MAX) return;
		if (entry.state === "running") continue;
		if (isUnreported(entry)) {
			if (unreported <= UNREPORTED_MAX) continue;
			unreported -= 1;
		}
		handled.delete(id);
	}
}

function remember(commandId: string, entry: HandledEntry) {
	handled.set(commandId, entry);
	if (handled.size > HANDLED_MAX) evictBounded();
}

export function registerDesktopCommandHost(
	next: DesktopCommandHost,
): () => void {
	host = next;
	return () => {
		if (host === next) host = null;
	};
}

function isForThisClient(payload: DesktopCommandDispatchedPayload): boolean {
	const clientId = getClientInstanceId();
	return Boolean(clientId && payload.targetClientId === clientId);
}

export type DesktopCommandTransport = {
	accept: (commandId: string) => Promise<{ accepted: boolean }>;
	report: (
		commandId: string,
		body: {
			status: TerminalDesktopCommandOutcome["status"];
			error: { code: string; message: string } | null;
		},
	) => Promise<unknown>;
};

const sdkTransport: DesktopCommandTransport = {
	accept: async (commandId) => (await loadSdk()).desktop.accept(commandId),
	report: async (commandId, body) =>
		(await loadSdk()).desktop.reportResult(commandId, body),
};
let transport = sdkTransport;

export function __setDesktopCommandTransportForTests(
	next: DesktopCommandTransport | null,
) {
	transport = next ?? sdkTransport;
}

export function getHandledSizeForTests(): number {
	return handled.size;
}

export function __resetDesktopCommandBusForTests(
	options: { retryMs?: number } = {},
) {
	handled.clear();
	host = null;
	retryMs = options.retryMs ?? 400;
}

/** Network errors, timeouts, rate limits, and 5xx may pass; other statuses are final. */
const isRetryable = (error: unknown) => {
	const status = (error as { status?: unknown } | null)?.status;
	return (
		typeof status !== "number" ||
		status === 408 ||
		status === 429 ||
		status >= 500
	);
};

async function withRetry<T>(
	label: string,
	run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; retryable: boolean }> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return { ok: true, value: await run() };
		} catch (error) {
			const retryable = isRetryable(error);
			if (!retryable || attempt === ATTEMPTS) {
				console.warn(`[desktop-command] failed to ${label}`, error);
				return { ok: false, retryable };
			}
			await new Promise((resolve) => setTimeout(resolve, retryMs * attempt));
		}
	}
}

async function report(
	commandId: string,
	outcome: TerminalDesktopCommandOutcome,
): Promise<void> {
	const sent = await withRetry("report result", () =>
		transport.report(commandId, {
			status: outcome.status,
			error: outcome.error ?? null,
		}),
	);
	remember(commandId, { state: "done", outcome, reported: sent.ok });
}

async function run(
	command: DesktopCommand,
	context: DesktopCommandContext,
	serve: DesktopCommandHost,
): Promise<DesktopCommandOutcome> {
	try {
		return await serve(command, context);
	} catch (error) {
		return {
			status: "rejected",
			error: {
				code: "host_failed",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

export async function handleDesktopCommand(
	payload: DesktopCommandDispatchedPayload,
): Promise<void> {
	const { commandId } = payload;
	const seen = handled.get(commandId);
	if (seen) {
		if (seen.state === "done" && !seen.reported) {
			await report(commandId, seen.outcome);
		}
		return;
	}
	remember(commandId, { state: "running" });

	const serve = host;
	if (!serve) return report(commandId, HOST_UNAVAILABLE);

	// A command that expired while the tab slept must not open a window.
	const accepted = await withRetry("accept command", () =>
		transport.accept(commandId),
	);
	if (!accepted.ok && accepted.retryable) {
		handled.delete(commandId);
		return;
	}
	if (!accepted.ok || !accepted.value.accepted) {
		remember(commandId, { state: "dropped" });
		return;
	}

	const outcome = await run(
		payload.command,
		{ commandId, source: payload.source },
		serve,
	);
	// `pending`: the App settles the command itself.
	if (outcome.status === "pending") {
		remember(commandId, { state: "delegated" });
		return;
	}
	await report(commandId, outcome);
}

function parsePayload(value: unknown): DesktopCommandDispatchedPayload | null {
	if (!value || typeof value !== "object") return null;
	const payload = value as Partial<DesktopCommandDispatchedPayload>;
	if (typeof payload.commandId !== "string" || !payload.commandId) return null;
	if (typeof payload.targetClientId !== "string" || !payload.targetClientId)
		return null;
	if (!payload.command || typeof payload.command !== "object") return null;
	return payload as DesktopCommandDispatchedPayload;
}

let stopListening: (() => void) | null = null;

export function startDesktopCommandListener(): () => void {
	if (stopListening) return stopListening;
	let off: (() => void) | null = null;
	let cancelled = false;
	void loadSdk().then((sdk) => {
		if (cancelled) return;
		off = sdk.onUserEvent((event) => {
			if (event.type !== "desktop.command.dispatched") return;
			const payload = parsePayload(event.payload);
			if (!payload || !isForThisClient(payload)) return;
			void handleDesktopCommand(payload);
		});
	});
	stopListening = () => {
		cancelled = true;
		off?.();
		stopListening = null;
	};
	return stopListening;
}
