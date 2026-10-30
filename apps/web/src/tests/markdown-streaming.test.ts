import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown, renderStreamingMarkdownSplit } from "../lib/markdown";

test("renderMarkdown keeps nested fences inside markdown code blocks", async () => {
	const html = await renderMarkdown(`\`\`\`markdown
---
description: Print the current time using bash
argument-hint: ""
category: general
---
Please run a bash command to output the current date and time.

Use:

\`\`\`bash
date
\`\`\`

Then return the command output directly.
\`\`\``);

	assert.match(html, /<pre/);
	assert.match(html, /language-markdown|shiki/);
	assert.match(html, /```bash/);
	assert.match(html, /Then return the command output directly\./);
	assert.doesNotMatch(
		html,
		/<p>Then return the command output directly\.<\/p>/,
	);
});

test("renderMarkdown adds href titles to links without overriding explicit titles", async () => {
	const html = await renderMarkdown(
		`[line](/workspace/apps/web/src/app.ts:12) [docs](docs/readme.md "Docs")`,
	);

	assert.match(
		html,
		/<a href="\/workspace\/apps\/web\/src\/app.ts:12" title="\/workspace\/apps\/web\/src\/app.ts:12">line<\/a>/,
	);
	assert.match(html, /<a href="docs\/readme.md" title="Docs">docs<\/a>/);
});

test("renderMarkdown supports safe README-style HTML", async () => {
	const html = await renderMarkdown(`<p align="center">
	<a href="https://cohub.run/"><img src="https://img.shields.io/badge/cohub-ready" alt="Cohub" width="800" /></a>
</p>

<p align="center"><em>Build with <code>@space</code>.</em></p>`);

	assert.match(html, /<p align="center">/);
	assert.match(
		html,
		/<a href="https:\/\/cohub\.run\/"[^>]*target="_blank"[^>]*>/,
	);
	assert.match(
		html,
		/<img src="https:\/\/img\.shields\.io\/badge\/cohub-ready" alt="Cohub" width="800">/,
	);
	assert.match(html, /<em>Build with <code>@space<\/code>\.<\/em>/);
});

test("renderMarkdown sanitizes unsafe source HTML", async () => {
	const html = await renderMarkdown(
		`<div id="cover" class="fixed" style="position:fixed" onclick="alert(1)">Safe</div>
<script>alert(2)</script>
<iframe src="https://example.com"></iframe>
<img src="javascript:alert(3)" onerror="alert(4)">
<a href="data:text/html,bad">bad</a>
Before <svg onload="alert(5)">unsafe</svg> after`,
	);

	assert.match(html, /<div>Safe<\/div>/);
	assert.match(html, /<img>/);
	assert.match(html, /<a>bad<\/a>/);
	assert.match(html, /Before\s+after/);
	assert.doesNotMatch(html, /unsafe/);
	assert.doesNotMatch(
		html,
		/<(?:script|iframe|svg)\b|\s(?:class|data-|href|id|onerror|onclick|src|style)=/,
	);
});

test("renderMarkdown allows web and workspace URLs in source HTML", async () => {
	const html = await renderMarkdown(`<a href="docs/readme.md">Docs</a>
<a href="../README.md#start">Parent</a>
<a href="/workspace/file.md">Workspace</a>
<a href="//cohub.run/docs">Web</a>
<img src="assets/preview.png" alt="Preview">`);

	assert.match(html, /href="docs\/readme\.md"/);
	assert.match(html, /href="\.\.\/README\.md#start"/);
	assert.match(html, /href="\/workspace\/file\.md"/);
	assert.match(html, /href="\/\/cohub\.run\/docs"/);
	assert.match(html, /src="assets\/preview\.png"/);
});

test("renderStreamingMarkdownSplit escapes source HTML in the live tail", async () => {
	const { stableHtml, tailHtml } = await renderStreamingMarkdownSplit(
		"<h1>Bad Request</h1>\n\n<img src=x onerror=alert(1)>",
	);
	const html = `${stableHtml}${tailHtml}`;

	assert.match(html, /&lt;h1&gt;Bad Request&lt;\/h1&gt;/);
	assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
	assert.doesNotMatch(html, /<(?:h1|hr|img|svg|script)\b/);
});

test("renderMarkdown renders mermaid fences as diagram placeholders", async () => {
	const html = await renderMarkdown("```mermaid\ngraph TD\n\tA --> B\n```");

	assert.match(html, /class="markdown-mermaid"/);
	assert.match(html, /<code class="language-mermaid">/);
});

test("renderMarkdown renders cohub ask fences as composer options", async () => {
	const html = await renderMarkdown(`\`\`\`cohub-ask
{
	"version": 1,
	"questions": [
		{
			"question": "How should we proceed?",
			"header": "Next step",
			"multiSelect": false,
			"options": [
				{
					"label": "Quick path",
					"description": "Ship the minimal renderer first.",
					"value": "Use the quick path."
				},
				{
					"label": "Full design",
					"description": "Define protocol and tests upfront.",
					"value": "Use the full design path."
				}
			]
		}
	]
}
\`\`\``);

	assert.match(html, /markdown-cohub-ask/);
	assert.match(html, /data-cohub-ask-option="true"/);
	assert.match(html, /data-cohub-ask-value="Use%20the%20quick%20path\."/);
	assert.doesNotMatch(html, /<pre class="shiki/);
});

test("renderMarkdown keeps invalid cohub ask fences as code", async () => {
	const html = await renderMarkdown(`\`\`\`cohub-ask
{"version":1,"questions":[]}
\`\`\``);

	assert.match(html, /<pre/);
	assert.match(html, /language-cohub-ask/);
	assert.doesNotMatch(html, /markdown-cohub-ask/);
});

test("renderStreamingMarkdownSplit keeps cohub ask fence streaming-safe", async () => {
	const source = `\`\`\`cohub-ask
{"version":1,"questions":[{"question":"Continue?","header":"Next","options":[{"label":"Yes","description":"Continue.","value":"Yes"},{"label":"No","description":"Stop.","value":"No"}]}]}
\`\`\``;
	const { stableHtml, tailHtml } = await renderStreamingMarkdownSplit(source);

	assert.match(stableHtml, /<pre/);
	assert.match(stableHtml, /language-cohub-ask/);
	assert.doesNotMatch(stableHtml, /markdown-cohub-ask/);
	assert.equal(tailHtml, "");
});

test("renderStreamingMarkdownSplit renders unclosed fence as plain code in tail", async () => {
	const { stableHtml, tailHtml } = await renderStreamingMarkdownSplit(
		"```ts\nconst value = 1;",
	);

	// Short source (< 140 chars) → everything in tail, stable empty
	assert.equal(stableHtml, "");
	assert.match(tailHtml, /data-streaming-code="true"/);
	assert.match(tailHtml, /const value = 1;/);
	assert.doesNotMatch(tailHtml, /shiki/);
});

test("renderStreamingMarkdownSplit does not run shiki on closed fence", async () => {
	const { stableHtml, tailHtml } = await renderStreamingMarkdownSplit(
		"```ts\nconst value = 1;\n```",
	);

	// Closed fence → stable region, rendered without shiki during streaming
	assert.match(stableHtml, /<pre/);
	assert.doesNotMatch(stableHtml, /shiki/);
	assert.equal(tailHtml, "");
});

test("renderStreamingMarkdownSplit splits long content into stable and tail", async () => {
	// The tail must be long enough (>= 84 chars) for findStreamingSafeIndex
	// to place the paragraph boundary in the stable region.
	const stablePara =
		"This is a stable paragraph that is long enough to be promoted.".repeat(3);
	const tailPara =
		"The answer ends with **bol and we need enough text here to ensure the tail is long enough for splitting.";
	const source = `${stablePara}\n\n${tailPara}`;

	const { stableHtml, tailHtml } = await renderStreamingMarkdownSplit(source);

	assert.match(stableHtml, /stable paragraph/);
	assert.ok(tailHtml.length > 0, "tail should contain the growing paragraph");
	// remend repairs the unclosed **, so the tail renders as bold
	assert.match(tailHtml, /bol/);
});

test("renderStreamingMarkdownSplit renders very long tail as plain text", async () => {
	const source = `The answer starts with **bold and keeps going ${"word ".repeat(420)}`;
	const { stableHtml, tailHtml } = await renderStreamingMarkdownSplit(source);

	assert.equal(stableHtml, "");
	assert.match(tailHtml, /markdown-streaming-tail/);
	assert.match(tailHtml, /\*\*bold/);
	assert.doesNotMatch(tailHtml, /<strong>/);
});

test("renderStreamingMarkdownSplit returns empty for empty source", async () => {
	const { stableHtml, tailHtml } = await renderStreamingMarkdownSplit("");

	assert.equal(stableHtml, "");
	assert.equal(tailHtml, "");
});
