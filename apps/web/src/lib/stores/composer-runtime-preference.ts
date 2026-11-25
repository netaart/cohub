import {
	type HarnessKind,
	isLocalHarness,
	isModelThinkingLevel,
	type LocalHarness,
	resolveHarness,
} from "@cohub/protocol";
import { encodeKeyPart, getCacheUserKey } from "#lib/cache/keys.ts";
import type { LocalModelSelection } from "#lib/model-catalog.ts";

const STORAGE_PREFIX = "cohub:composer-runtime:v1";

export type ComposerRuntimePreference = {
	harness: HarnessKind;
	models: Partial<Record<LocalHarness, LocalModelSelection>>;
};

export function composerRuntimeKey(spaceId: string) {
	return [STORAGE_PREFIX, getCacheUserKey(), spaceId]
		.map(encodeKeyPart)
		.join(":");
}

function parseModel(value: unknown): LocalModelSelection | null {
	if (!value || typeof value !== "object") return null;
	const { provider, id, name, thinkingLevel, serviceTier } = value as Record<
		string,
		unknown
	>;
	if (typeof provider !== "string" || !provider) return null;
	if (typeof id !== "string" || !id) return null;
	return {
		provider,
		id,
		...(typeof name === "string" ? { name } : {}),
		...(isModelThinkingLevel(thinkingLevel) ? { thinkingLevel } : {}),
		...(typeof serviceTier === "string" && serviceTier ? { serviceTier } : {}),
	};
}

export function readComposerRuntime(
	key: string,
): ComposerRuntimePreference | null {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		const record = JSON.parse(raw) as { harness?: unknown; models?: unknown };
		const models =
			record.models && typeof record.models === "object" ? record.models : {};
		return {
			harness: resolveHarness(record),
			models: Object.fromEntries(
				Object.entries(models).flatMap(([harness, model]) => {
					const parsed = isLocalHarness(harness) ? parseModel(model) : null;
					return parsed ? [[harness, parsed]] : [];
				}),
			),
		};
	} catch {
		return null;
	}
}

export function rememberComposerRuntime(
	key: string,
	harness: HarnessKind,
	model?: LocalModelSelection,
): ComposerRuntimePreference {
	const models = readComposerRuntime(key)?.models ?? {};
	const next: ComposerRuntimePreference = {
		harness,
		models:
			harness !== "cohub" && model ? { ...models, [harness]: model } : models,
	};
	try {
		localStorage.setItem(
			key,
			JSON.stringify({ ...next, updatedAt: Date.now() }),
		);
	} catch {
		// Storage may be unavailable.
	}
	return next;
}
