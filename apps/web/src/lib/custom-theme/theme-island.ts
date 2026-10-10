import { notifyCustomThemeChanged } from "$lib/custom-theme/events";
import {
	isRootSelector,
	scopeSelectorList,
	splitSelectorList,
} from "$lib/custom-theme/island-selectors";

const THEME_ISLAND_ATTR = "data-theme-island";
const STYLE_ATTR = "data-cohub-theme-island";
const HOISTED_RULES = [
	"CSSFontFaceRule",
	"CSSKeyframesRule",
	"CSSCounterStyleRule",
	"CSSFontFeatureValuesRule",
	"CSSFontPaletteValuesRule",
	"CSSLayerStatementRule",
];
const COMPILE_CACHE_LIMIT = 8;

const compiled = new Map<string, string | null>();
let tailwindTokens = "";

export function isThemeIslandSupported() {
	return typeof CSSScopeRule !== "undefined";
}

function isRule(rule: CSSRule, name: string) {
	const ctor = (globalThis as Record<string, unknown>)[name];
	return typeof ctor === "function" && rule instanceof ctor;
}

function scopeRules(rules: CSSRuleList) {
	for (const rule of rules) {
		if (rule instanceof CSSStyleRule) {
			rule.selectorText = scopeSelectorList(rule.selectorText);
		} else if (rule instanceof CSSGroupingRule) {
			scopeRules(rule.cssRules);
		}
	}
}

// Tailwind resolves `--color-*` once on `:root`; re-declare them on the island root.
function readTailwindTokens(): string {
	if (tailwindTokens) return tailwindTokens;
	const declarations: string[] = [];
	for (const sheet of document.styleSheets) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		for (const rule of rules) {
			if (!(rule instanceof CSSLayerBlockRule) || rule.name !== "theme")
				continue;
			for (const child of rule.cssRules) {
				if (
					child instanceof CSSStyleRule &&
					child.selectorText === ":root, :host"
				)
					declarations.push(child.style.cssText);
			}
		}
	}
	tailwindTokens = declarations.join(" ");
	return tailwindTokens;
}

function parse(source: string): CSSStyleSheet | null {
	const sheet = new CSSStyleSheet();
	try {
		sheet.replaceSync(source);
	} catch {
		return null;
	}
	scopeRules(sheet.cssRules);
	return sheet;
}

// The account theme already applies page-wide; the island only re-declares its root tokens.
function keepRootTokens(group: CSSStyleSheet | CSSGroupingRule): boolean {
	for (let index = group.cssRules.length - 1; index >= 0; index -= 1) {
		const rule = group.cssRules[index];
		let keep = false;
		if (rule instanceof CSSStyleRule) {
			const roots = splitSelectorList(rule.selectorText).filter(isRootSelector);
			if (roots.length > 0) {
				rule.selectorText = roots.join(", ");
				for (const name of Array.from(rule.style)) {
					if (!name.startsWith("--")) rule.style.removeProperty(name);
				}
				while (rule.cssRules.length > 0) rule.deleteRule(0);
				keep = rule.style.length > 0;
			}
		} else if (rule instanceof CSSGroupingRule) {
			keep = keepRootTokens(rule);
		}
		if (!keep) group.deleteRule(index);
	}
	return group.cssRules.length > 0;
}

function compile(spaceCss: string, accountCss: string | null): string | null {
	const space = parse(spaceCss);
	if (!space) return null;
	const hoisted: string[] = [];
	const scoped: string[] = [];
	for (const rule of space.cssRules) {
		if (HOISTED_RULES.some((name) => isRule(rule, name))) {
			hoisted.push(rule.cssText);
		} else if (
			rule instanceof CSSStyleRule ||
			rule instanceof CSSGroupingRule
		) {
			scoped.push(rule.cssText);
		}
	}
	if (scoped.length === 0) return null;
	const account = accountCss === null ? null : parse(accountCss);
	const accountTokens =
		account && keepRootTokens(account)
			? Array.from(account.cssRules, (rule) => rule.cssText)
			: [];
	return [
		...hoisted,
		`@scope ([${THEME_ISLAND_ATTR}]) {`,
		`:scope { ${readTailwindTokens()} }`,
		...accountTokens,
		...scoped,
		"}",
	].join("\n");
}

export function compileThemeIsland(
	spaceCss: string,
	accountCss: string | null,
): string | null {
	const key = `${accountCss ?? ""}\n/* cohub-space-theme */\n${spaceCss}`;
	if (compiled.has(key)) {
		const hit = compiled.get(key) ?? null;
		compiled.delete(key);
		compiled.set(key, hit);
		return hit;
	}
	const css = compile(spaceCss, accountCss);
	compiled.set(key, css);
	if (compiled.size > COMPILE_CACHE_LIMIT) {
		compiled.delete(compiled.keys().next().value as string);
	}
	return css;
}

export function applyThemeIsland(css: string | null, spaceId: string) {
	if (typeof document === "undefined") return;
	let node = document.head.querySelector<HTMLStyleElement>(
		`style[${STYLE_ATTR}]`,
	);
	if ((node?.textContent ?? null) === css) return;
	if (css === null) {
		node?.remove();
	} else {
		if (!node) {
			node = document.createElement("style");
			node.setAttribute(STYLE_ATTR, "");
			document.head.append(node);
		}
		node.textContent = css;
	}
	notifyCustomThemeChanged(spaceId);
}
