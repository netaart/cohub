import assert from "node:assert/strict";
import { test } from "node:test";
import { yamlLanguage } from "@codemirror/lang-yaml";
import type { Extension } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import {
	withLanguageHighlights,
	YAML_SCALAR_HIGHLIGHT_STYLE,
} from "#lib/code-editor-highlight.ts";

/**
 * `@codemirror/lang-yaml` tags every plain scalar — string, number, bool and
 * null — as `content`. The editor colors YAML values through that tag, so pin
 * the behavior here: a dependency bump that drops or renames the tag would
 * otherwise silently disable YAML highlighting.
 */
function highlightedSpans(doc: string) {
	const tree = yamlLanguage.parser.parse(doc);
	const spans: Array<{ from: number; to: number }> = [];
	highlightTree(tree, YAML_SCALAR_HIGHLIGHT_STYLE, (from, to) => {
		spans.push({ from, to });
	});
	return spans;
}

test("yaml plain scalars are highlighted through the content tag", () => {
	const doc = "name: Test & Deploy\ncount: 3\ndebug: true\nempty: null\n";
	const spans = highlightedSpans(doc);

	for (const scalar of ["Test & Deploy", "3", "true", "null"]) {
		const from = doc.indexOf(scalar);
		assert.ok(
			spans.some(
				(span) => span.from === from && span.to === from + scalar.length,
			),
			`expected ${JSON.stringify(scalar)} to be highlighted`,
		);
	}

	// Keys belong to the shared property rule, not the scalar rule.
	const keyFrom = doc.indexOf("name");
	assert.ok(
		!spans.some((span) => span.from === keyFrom && span.to === keyFrom + 4),
		"keys should not be highlighted by the YAML scalar style",
	);
});

test("yaml scalar highlighting is scoped to the yaml language", () => {
	const base: Extension = [];
	assert.equal(withLanguageHighlights("markdown", base), base);

	const yamlExtension = withLanguageHighlights("yml", base) as Extension[];
	assert.ok(Array.isArray(yamlExtension));
	assert.equal(yamlExtension.length, 2);
	assert.equal(yamlExtension[0], base);
});
