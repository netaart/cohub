import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../lib/markdown";

const count = (html: string, pattern: RegExp) =>
	(html.match(pattern) ?? []).length;

test("renders TeX delimiters without eating escapes", async () => {
	const html = await renderMarkdown(`令 $u = \\arcsin e^x$，内联 \\(a_1\\)。
$$\\int\\frac{1}{x}\\,dx$$

1. Item:
   \\[
   \\boxed{x}
   \\]`);
	assert.equal(count(html, /class="katex"/g), 4);
	assert.equal(count(html, /<div class="markdown-math-display"/g), 2);
	assert.doesNotMatch(html, /\$|\\\(|\\\[|annotation|\\arcsin/);
});

test("keeps prices, code, and invalid TeX as source", async () => {
	const html = await renderMarkdown(
		"It costs $5 and $10. `$y$` and \\$x\\$. $\\frac{a$ and $$\\bad{x}$$\n\n```bash\necho $HOME\n```",
	);
	assert.doesNotMatch(html, /katex/);
	assert.match(html, /\$5 and \$10/);
	assert.match(html, /<code>\$y\$<\/code>/);
	assert.match(html, /\$\$\\bad\{x\}\$\$/);
});
