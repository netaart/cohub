import { getContext, setContext } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { sdk } from "$lib/sdk";
import { billingConversion } from "$lib/stores/billing-conversion.svelte";
import { TurnSpeechPlayer } from "$lib/turn-speech-player.svelte";

const voices = new SvelteMap<string, string | null>();
const cacheKey = (spaceId: string) => `cohub:space-speech-voice:${spaceId}:v1`;

export function setSpeechVoice(spaceId: string, voice: string | null) {
	voices.set(spaceId, voice);
	try {
		if (voice) localStorage.setItem(cacheKey(spaceId), voice);
		else localStorage.removeItem(cacheKey(spaceId));
	} catch {}
}

export function getSpeechVoice(spaceId: string): string | null {
	const known = voices.get(spaceId);
	if (known !== undefined) return known;
	try {
		return localStorage.getItem(cacheKey(spaceId));
	} catch {
		return null;
	}
}

const contextKey = Symbol("cohub.chat.turn-speech");

export function provideTurnSpeech(spaceId: () => string | null) {
	setContext(contextKey, spaceId);
}

export function useTurnSpeech(): (() => string | null) | undefined {
	return getContext<(() => string | null) | undefined>(contextKey);
}

export const turnSpeechPlayer = new TurnSpeechPlayer({
	speak: async (spaceId, turn) =>
		(await sdk.space(spaceId).session(turn.sessionId).turn(turn.id).speak())
			.speech,
	handleError: (error) => billingConversion.handleHttpError(error),
});
