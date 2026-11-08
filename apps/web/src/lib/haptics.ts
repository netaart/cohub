import { APP_RUNTIME_HAPTIC_VIBRATION } from "@cohub/protocol/app-runtime";
import type { HostHaptic } from "@cohub/protocol/host-bridge";
import { callHost, supportsHostCapability } from "$lib/host-bridge";

const GAP_MS = 40;
let lastAt = 0;

export function haptic(kind: HostHaptic) {
	const now = performance.now();
	if (now - lastAt < GAP_MS) return;
	lastAt = now;
	if (supportsHostCapability("haptics")) {
		callHost("haptics.perform", { kind }).catch(() => {});
		return;
	}
	try {
		navigator.vibrate?.(APP_RUNTIME_HAPTIC_VIBRATION[kind]);
	} catch {}
}
