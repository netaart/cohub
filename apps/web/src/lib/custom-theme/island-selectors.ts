export function splitSelectorList(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quote) {
			if (char === "\\") index += 1;
			else if (char === quote) quote = null;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(" || char === "[") {
			depth += 1;
		} else if (char === ")" || char === "]") {
			depth -= 1;
		} else if (char === "," && depth === 0) {
			parts.push(text.slice(start, index).trim());
			start = index + 1;
		}
	}
	parts.push(text.slice(start).trim());
	return parts.filter(Boolean);
}

const ATTRIBUTE = /(\[(?:[^\]"']|"[^"]*"|'[^']*')*\])/;
const ROOT_PSEUDO = /:root(?![\w-])/g;
const ROOT_TYPE = /(^|[\s>+~(,])(?:html|body)(?![\w-])/g;
const NESTED_SCOPE =
	/:scope((?:\[(?:[^\]"']|"[^"]*"|'[^']*')*\]|[.#:][\w-]+(?:\([^)]*\))?)*)\s*>?\s*:scope/g;

export function scopeSelector(selector: string): string {
	const rewritten = selector
		.split(ATTRIBUTE)
		.map((part, index) =>
			index % 2 === 1
				? part
				: part.replace(ROOT_PSEUDO, ":scope").replace(ROOT_TYPE, "$1:scope"),
		)
		.join("");
	return rewritten.replace(NESTED_SCOPE, ":scope$1");
}

export function scopeSelectorList(text: string): string {
	return splitSelectorList(text).map(scopeSelector).join(", ");
}

export function isRootSelector(selector: string): boolean {
	let outer = selector
		.split(ATTRIBUTE)
		.map((part, index) => (index % 2 === 1 ? "[]" : part))
		.join("");
	while (/\([^()]*\)/.test(outer)) outer = outer.replace(/\([^()]*\)/g, "");
	return outer.includes(":scope") && !/[\s>+~]/.test(outer.trim());
}
