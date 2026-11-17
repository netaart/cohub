import type { NewChatComposerApplyPayload } from "#lib/space-config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object");
}

function isHttpsUrl(value: unknown) {
	if (typeof value !== "string") return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

function parseComposerPayload(
	value: unknown,
): NewChatComposerApplyPayload | null {
	if (!isRecord(value)) return null;
	const payload: NewChatComposerApplyPayload = {};
	if (typeof value.prompt === "string") payload.prompt = value.prompt;
	if (isRecord(value.model)) {
		const { provider, id } = value.model;
		if (typeof provider === "string" && typeof id === "string") {
			payload.model = { provider, id };
		}
	}
	if (Array.isArray(value.images)) {
		payload.images = value.images.filter(isRecord).flatMap((image) => {
			if (!isHttpsUrl(image.url)) return [];
			return [
				{
					url: String(image.url),
					name: typeof image.name === "string" ? image.name : undefined,
				},
			];
		});
	}
	return payload.prompt !== undefined || payload.model || payload.images?.length
		? payload
		: null;
}

export function parseNewChatBackgroundAction(
	data: unknown,
): NewChatComposerApplyPayload | null {
	if (!isRecord(data)) return null;
	if (data.source !== "cohub.newChat") return null;
	if (data.version !== 1) return null;
	if (data.type !== "composer.apply") return null;
	return parseComposerPayload(data.payload);
}
