import type { HostHaptic } from "@cohub/protocol/host-bridge";
import { callHost, supportsHostCapability } from "$lib/host-bridge";

const VIBRATION: Record<HostHaptic, number | number[]> = {
	tick: 8,
	confirm: [12, 24, 12],
	reject: [24, 32, 24],
	longPress: 14,
};

export function haptic(kind: HostHaptic) {
	if (supportsHostCapability("haptics")) {
		callHost("haptics.perform", { kind }).catch(() => {});
		return;
	}
	try {
		navigator.vibrate?.(VIBRATION[kind]);
	} catch {}
}
