import type { HostTabState } from "@cohub/protocol/host-bridge";
import { callHost, readyHost, supportsHostCapability } from "$lib/host-bridge";

let sentDirty = false;
let sentCapture = false;
const keyHolders = new Set<symbol>();

function send(state: HostTabState) {
	void readyHost().then(() => {
		if (!supportsHostCapability("tabs")) return;
		callHost("tabs.update", state).catch(() => {});
	});
}

export function setHostTabDirty(dirty: boolean) {
	if (dirty === sentDirty) return;
	sentDirty = dirty;
	send({ dirty });
}

export function flagHostTabAttention() {
	if (typeof document === "undefined") return;
	if (!document.hidden && document.hasFocus()) return;
	send({ attention: true });
}

export function holdHostKeys(): () => void {
	const holder = Symbol("host-keys");
	keyHolders.add(holder);
	syncKeys();
	return () => {
		if (!keyHolders.delete(holder)) return;
		syncKeys();
	};
}

function syncKeys() {
	const capture = keyHolders.size > 0;
	if (capture === sentCapture) return;
	sentCapture = capture;
	send({ captureKeys: capture });
}
