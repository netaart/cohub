import {
	type LocalWorkspaceResolver,
	LocalWorkspaceRpcError,
	type LocalWorkspaceTransport,
	LocalWorkspaceUnavailableError,
} from "@neta-art/cohub";
import {
	HOST_BRIDGE_ERROR,
	HOST_WORKSPACE_CALL_MAX_BYTES,
	HostBridgeErrorClass,
	hostWorkspaceFileUrl,
} from "@neta-art/cohub/host-bridge";
import { deviceRuntimeInstance } from "$lib/device-runtime.svelte";
import {
	callHost,
	hostPlatform,
	supportsHostCapability,
} from "$lib/host-bridge";

const encoder = new TextEncoder();

const unavailable = (message: string) =>
	new LocalWorkspaceUnavailableError(message);

async function call(
	spaceId: string,
	method: string,
	params: unknown,
): Promise<unknown> {
	if (!method.startsWith("fs.")) throw unavailable("Not served by the host");
	const request = {
		spaceId,
		method,
		params: (params ?? {}) as Record<string, unknown>,
	};
	if (
		encoder.encode(JSON.stringify(request)).byteLength >
		HOST_WORKSPACE_CALL_MAX_BYTES
	)
		throw unavailable("Too large for the host bridge");
	let answer: Awaited<ReturnType<typeof callHost<"workspace.call">>>;
	try {
		answer = await callHost("workspace.call", request);
	} catch (error) {
		const code = error instanceof HostBridgeErrorClass ? error.code : null;
		if (
			code === HOST_BRIDGE_ERROR.unavailable ||
			code === HOST_BRIDGE_ERROR.unsupported
		)
			throw unavailable((error as Error).message);
		throw error;
	}
	if ("error" in answer)
		throw new LocalWorkspaceRpcError(answer.error.code, answer.error.message);
	return answer.result;
}

async function open(url: string, init: RequestInit = {}) {
	const response = await fetch(url, init);
	if (response.ok) return response;
	if (response.status === 503)
		throw unavailable("The local Runtime is not reachable");
	const body = (await response.json().catch(() => null)) as {
		error?: { code: string; message: string };
	} | null;
	throw new LocalWorkspaceRpcError(
		body?.error?.code ?? "IO_ERROR",
		body?.error?.message ?? "File read failed",
	);
}

function hostWorkspace(spaceId: string): LocalWorkspaceTransport {
	const transport: LocalWorkspaceTransport = {
		call: (method, params) => call(spaceId, method, params),
	};
	if (!supportsHostCapability("workspace.files")) return transport;
	const url = (path: string, version?: string) =>
		hostWorkspaceFileUrl({
			platform: hostPlatform() ?? "unknown",
			origin: window.location.origin,
			spaceId,
			path,
			version,
		});
	return { ...transport, url, open: (path, init) => open(url(path), init) };
}

export const resolveHostWorkspace: LocalWorkspaceResolver = (spaceId) =>
	supportsHostCapability("workspace") &&
	deviceRuntimeInstance(spaceId)?.state === "ready"
		? hostWorkspace(spaceId)
		: null;
