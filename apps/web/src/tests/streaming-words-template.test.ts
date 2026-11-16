import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "svelte/compiler";

type AstNode = {
	type: string;
	name?: string;
	data?: string;
	fragment?: { nodes: AstNode[] };
	consequent?: { nodes: AstNode[] };
	alternate?: { nodes: AstNode[] } | null;
	attributes?: { type: string; name: string; value: unknown }[];
};

const source = readFileSync(
	new URL("../lib/components/StreamingWords.svelte", import.meta.url),
	"utf8",
);

function children(node: AstNode): AstNode[] {
	return [
		...(node.fragment?.nodes ?? []),
		...(node.consequent?.nodes ?? []),
		...(node.alternate?.nodes ?? []),
	];
}

function findRoot(nodes: AstNode[]): AstNode | undefined {
	for (const node of nodes) {
		const isRoot =
			node.type === "RegularElement" &&
			node.name === "span" &&
			node.attributes?.some(
				(attr) =>
					attr.name === "class" &&
					JSON.stringify(attr.value).includes("streaming-words"),
			);
		if (isRoot) return node;
		const nested = findRoot(children(node));
		if (nested) return nested;
	}
	return undefined;
}

// The live thinking text renders as {stableText}<span>{tailText}</span> inside a
// white-space: pre-wrap container. Any whitespace between those nodes becomes a
// visible space at the stable/tail boundary — usually mid-word, since deltas are
// cut anywhere — which then vanishes when the next delta folds the tail in.
test("streaming words keep stable text, tail and caret touching", () => {
	const ast = parse(source, { modern: true }) as unknown as {
		fragment: { nodes: AstNode[] };
	};
	const root = findRoot(ast.fragment.nodes);
	assert.ok(root, "streaming-words root span not found");

	const stray: string[] = [];
	const visit = (node: AstNode) => {
		for (const child of children(node)) {
			if (child.type === "Text" && /^\s+$/.test(child.data ?? "")) {
				stray.push(JSON.stringify(child.data));
			}
			// Only the text the user reads matters; the tail/caret spans' own
			// children are a single expression or empty.
			if (child.type !== "RegularElement") visit(child);
		}
	};
	visit(root);

	assert.deepEqual(stray, [], "whitespace text nodes inside streaming-words");
});
