/**
 * Monogram for generated avatar tiles (Apps, Spaces).
 *
 * Latin-like scripts get two letters ("Pixel Editor" → "PE", "cohub" → "CO").
 * Wide glyphs — CJK, Hangul, kana, emoji — get exactly one, since two of them
 * cannot share a small square legibly ("我的待办" → "我", "🎨 调色板" → "🎨").
 * Punctuation and symbols only separate words, so "[beta] tool" → "BT".
 */

/** Grapheme that can start a word in a monogram. */
const WORD_GLYPH = /^[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/** Grapheme that fills a square tile by itself. */
const WIDE_GLYPH =
	/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Extended_Pictographic}]/u;

let segmenter: Intl.Segmenter | null | undefined;

function graphemes(text: string): string[] {
	if (segmenter === undefined) {
		segmenter =
			typeof Intl !== "undefined" && "Segmenter" in Intl
				? new Intl.Segmenter(undefined, { granularity: "grapheme" })
				: null;
	}
	return segmenter
		? Array.from(segmenter.segment(text), (part) => part.segment)
		: Array.from(text);
}

function words(text: string): string[][] {
	const result: string[][] = [];
	let current: string[] = [];
	for (const glyph of graphemes(text)) {
		if (WORD_GLYPH.test(glyph)) {
			current.push(glyph);
		} else if (current.length > 0) {
			result.push(current);
			current = [];
		}
	}
	if (current.length > 0) result.push(current);
	return result;
}

function isWideGlyph(glyph: string) {
	return WIDE_GLYPH.test(glyph);
}

/** Whether a monogram is a single glyph, which tiles can render larger. */
export function isSingleGlyph(initials: string) {
	return isWideGlyph(initials) || graphemes(initials).length === 1;
}

export function avatarInitials(
	value: string | null | undefined,
	fallback: string,
) {
	const [head, next] = words(value ?? "");
	const first = head?.[0];
	if (!first) return fallback;
	if (isWideGlyph(first)) return first;
	const candidate = next?.[0] && !isWideGlyph(next[0]) ? next[0] : head[1];
	const second = candidate && !isWideGlyph(candidate) ? candidate : "";
	return `${first}${second}`.toUpperCase();
}
