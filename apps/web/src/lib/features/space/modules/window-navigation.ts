import type { WindowRef } from "./window-route.ts";

export type WindowNavigationSource = "user" | "route" | "restore";

export type WindowNavigationState = {
	desiredRef: WindowRef | null;
	source: WindowNavigationSource;
	transitionId: number;
};

export function createWindowNavigationState(): WindowNavigationState {
	return {
		desiredRef: null,
		source: "restore",
		transitionId: 0,
	};
}

export function beginWindowNavigation(
	state: WindowNavigationState,
	desiredRef: WindowRef | null,
	source: WindowNavigationSource,
): WindowNavigationState {
	return {
		desiredRef,
		source,
		transitionId: state.transitionId + 1,
	};
}

export function alignWindowNavigation(
	state: WindowNavigationState,
	desiredRef: WindowRef | null,
): WindowNavigationState {
	return { ...state, desiredRef };
}

export function isCurrentWindowNavigation(
	state: WindowNavigationState,
	transitionId: number,
): boolean {
	return state.transitionId === transitionId;
}

export function windowRefsEqual(
	a: WindowRef | null,
	b: WindowRef | null,
): boolean {
	return a?.kind === b?.kind && a?.key === b?.key;
}
