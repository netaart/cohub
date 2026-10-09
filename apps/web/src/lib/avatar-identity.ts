/** Must match the `--identity-*` tokens in theme.css. */
export const IDENTITY_TONE_COUNT = 8;

export function identityTone(seed: string | null | undefined): number | null {
	const value = seed?.trim();
	if (!value) return null;
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return ((hash >>> 0) % IDENTITY_TONE_COUNT) + 1;
}

export function identityToken(tone: number) {
	return `--identity-${tone}`;
}

export function identityColor(seed: string | null | undefined) {
	const tone = identityTone(seed);
	return tone ? `var(${identityToken(tone)})` : "var(--text-tertiary)";
}
