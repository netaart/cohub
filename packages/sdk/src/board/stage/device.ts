import { type BoardLod, COMPACT_BOARD_LOD, DEFAULT_BOARD_LOD } from "../render/lod.js";
import { COMPACT_LRU_BUDGET, DEFAULT_LRU_BUDGET, type LruBudget } from "./lru.js";

export type BoardDeviceTier = "low" | "standard" | "high";

export type BoardDeviceSignals = {
	phone?: boolean;
	memory?: number;
	cores?: number;
	saveData?: boolean;
	slowNetwork?: boolean;
};

export type BoardDeviceBudget = {
	tier: BoardDeviceTier;
	lod: BoardLod;
	lru: LruBudget;
	concurrency: number;
	prefetch: number;
};

const BUDGETS: Record<BoardDeviceTier, Omit<BoardDeviceBudget, "tier">> = {
	low: { lod: COMPACT_BOARD_LOD, lru: COMPACT_LRU_BUDGET, concurrency: 4, prefetch: 0 },
	standard: { lod: DEFAULT_BOARD_LOD, lru: DEFAULT_LRU_BUDGET, concurrency: 6, prefetch: 0.5 },
	// Memory and cores say nothing about the GPU, so no tier raises the live budget.
	high: {
		lod: DEFAULT_BOARD_LOD,
		lru: { maxCount: 4096, maxBytes: 384 * 1024 * 1024 },
		concurrency: 8,
		prefetch: 1,
	},
};

export const BOARD_DEVICE_TIERS = Object.keys(BUDGETS) as readonly BoardDeviceTier[];

const PHONE_SHORT_SIDE = 600;

export type BoardDeviceEnvironment = {
	navigator?: Navigator & {
		deviceMemory?: number;
		connection?: { saveData?: boolean; effectiveType?: string };
	};
	matchMedia?: (query: string) => { matches: boolean };
	screen?: { width: number; height: number };
};

export function readBoardDeviceSignals(environment: BoardDeviceEnvironment = globalThis as BoardDeviceEnvironment): BoardDeviceSignals {
	const { navigator: device, matchMedia, screen } = environment;
	if (!device || !matchMedia || !screen) return {};
	const connection = device.connection;
	return {
		phone:
			matchMedia("(pointer: coarse)").matches &&
			!matchMedia("(any-pointer: fine)").matches &&
			Math.min(screen.width, screen.height) < PHONE_SHORT_SIDE,
		memory: device.deviceMemory,
		cores: device.hardwareConcurrency,
		saveData: Boolean(connection?.saveData),
		slowNetwork: /^(slow-2g|2g|3g)$/.test(connection?.effectiveType ?? ""),
	};
}

export function boardDeviceTier({ phone, memory, cores }: BoardDeviceSignals): BoardDeviceTier {
	if ((memory !== undefined && memory <= 2) || (cores !== undefined && cores <= 2)) return "low";
	if (phone) return memory !== undefined && memory >= 8 ? "standard" : "low";
	if (memory !== undefined && memory <= 4 && cores !== undefined && cores <= 4) return "low";
	if (memory !== undefined && memory >= 8 && cores !== undefined && cores >= 8) return "high";
	return "standard";
}

export function boardDeviceBudget(signals: BoardDeviceSignals, tier = boardDeviceTier(signals)): BoardDeviceBudget {
	const budget = BUDGETS[tier];
	return { tier, ...budget, prefetch: signals.saveData || signals.slowNetwork ? 0 : budget.prefetch };
}

let detected: BoardDeviceBudget | undefined;

export function defaultBoardDeviceBudget(): BoardDeviceBudget {
	detected ??= boardDeviceBudget(readBoardDeviceSignals());
	return detected;
}
