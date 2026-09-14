import {
	APP_SURFACE_READY_TIMEOUT_MS,
	APP_SURFACE_REQUEST_TIMEOUT_MS,
} from "@cohub/protocol/app-surface";
import type {
	AppDetailResponse,
	AppRuntimeInvocationContext,
} from "@neta-art/cohub";

export type AppSurfaceCallOutcome =
	| { ok: true; result?: unknown }
	| { ok: false; code: string; message: string };

export type AppSurfaceInvoker = (input: {
	method: string;
	input?: unknown;
	commandId: string;
	invocation: AppRuntimeInvocationContext;
	readyTimeoutMs?: number;
	requestTimeoutMs?: number;
}) => Promise<AppSurfaceCallOutcome>;

/** One App can be mounted by several hosts at once (a tab and an overlay). */
export type AppSurfaceKey = { appId: string; surface: "app" | "overlay" };

const keyOf = ({ appId, surface }: AppSurfaceKey) => `${surface}:${appId}`;

/** What a host must know about one App surface to call into it. */
export type AppSurfaceCallTarget = {
	detail: AppDetailResponse | null;
	error: string | null;
	invocation: AppRuntimeInvocationContext;
};

const EMBEDDED_KINDS = new Set(["web", "port"]);
const INVOKER_WAIT_MS = 5_000;

/**
 * Shared "call a method on a mounted App surface" flow used by every host that
 * embeds Apps (preview tabs, overlays). Hosts own their surfaces; this registry
 * only tracks which surface currently has an iframe and waits for one to mount
 * without polling.
 */
export function createAppSurfaceRegistry() {
	const invokers = new Map<string, AppSurfaceInvoker>();
	const waiters = new Map<
		string,
		Set<(invoker: AppSurfaceInvoker | null) => void>
	>();

	function register(key: AppSurfaceKey, invoker: AppSurfaceInvoker) {
		const id = keyOf(key);
		invokers.set(id, invoker);
		const pending = waiters.get(id);
		if (pending) {
			waiters.delete(id);
			for (const settle of pending) settle(invoker);
		}
		return () => {
			if (invokers.get(id) === invoker) invokers.delete(id);
		};
	}

	function unregister(key: AppSurfaceKey) {
		invokers.delete(keyOf(key));
	}

	function waitFor(key: AppSurfaceKey, timeoutMs = INVOKER_WAIT_MS) {
		const id = keyOf(key);
		const existing = invokers.get(id);
		if (existing) return Promise.resolve(existing);
		return new Promise<AppSurfaceInvoker | null>((resolve) => {
			const settle = (invoker: AppSurfaceInvoker | null) => {
				clearTimeout(timer);
				resolve(invoker);
			};
			const timer = setTimeout(() => {
				waiters.get(id)?.delete(settle);
				resolve(null);
			}, timeoutMs);
			let pending = waiters.get(id);
			if (!pending) {
				pending = new Set();
				waiters.set(id, pending);
			}
			pending.add(settle);
		});
	}

	/**
	 * Calls `method` on the surface for `appId`. `getTarget` is read after
	 * `settled` resolves so a call issued right after opening waits for the
	 * detail fetch instead of racing it; returning `null` means the surface is
	 * gone.
	 */
	async function call(input: {
		key: AppSurfaceKey;
		method: string;
		input?: unknown;
		commandId: string;
		settled?: Promise<unknown>;
		getTarget: () => AppSurfaceCallTarget | null;
	}): Promise<AppSurfaceCallOutcome> {
		if (!input.getTarget()) {
			return {
				ok: false,
				code: "preview_not_open",
				message: "The App surface is not open.",
			};
		}
		await input.settled;
		const target = input.getTarget();
		if (!target) {
			return {
				ok: false,
				code: "preview_not_open",
				message: "The App surface was closed before the call ran.",
			};
		}
		if (target.error) {
			return { ok: false, code: "preview_failed", message: target.error };
		}
		const kind = target.detail?.content?.kind;
		if (!kind) {
			return {
				ok: false,
				code: "surface_not_supported",
				message: "This App has no published content to call into.",
			};
		}
		if (!EMBEDDED_KINDS.has(kind)) {
			return {
				ok: false,
				code: "surface_not_supported",
				message: `A ${kind} App renders natively and exposes no callable methods.`,
			};
		}
		const invoker = await waitFor(input.key);
		if (!invoker) {
			return {
				ok: false,
				code: "surface_unavailable",
				message: "The App surface did not mount.",
			};
		}
		return invoker({
			method: input.method,
			input: input.input,
			commandId: input.commandId,
			invocation: target.invocation,
			readyTimeoutMs: APP_SURFACE_READY_TIMEOUT_MS,
			requestTimeoutMs: APP_SURFACE_REQUEST_TIMEOUT_MS,
		});
	}

	function clear() {
		invokers.clear();
		// Settle outstanding waiters as "gone" instead of leaving them to time out.
		for (const pending of waiters.values())
			for (const settle of pending) settle(null);
		waiters.clear();
	}

	return { register, unregister, waitFor, call, clear };
}

export type AppSurfaceRegistry = ReturnType<typeof createAppSurfaceRegistry>;
