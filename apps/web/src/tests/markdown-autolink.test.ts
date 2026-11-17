import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../lib/markdown.ts";

test("renderMarkdown ends autolinks before Chinese prose punctuation", async () => {
	const html = await renderMarkdown(
		"PR 已创建: https://github.com/netaart/cohub/pull/342，改动一行。见 https://example.com/a（说明）与 https://example.com/b。",
	);

	assert.match(
		html,
		/<a href="https:\/\/github\.com\/netaart\/cohub\/pull\/342"[^>]*>https:\/\/github\.com\/netaart\/cohub\/pull\/342<\/a>，改动一行。/,
	);
	assert.match(
		html,
		/<a href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>（说明）/,
	);
	assert.match(
		html,
		/<a href="https:\/\/example\.com\/b"[^>]*>https:\/\/example\.com\/b<\/a>。/,
	);
});

test("renderMarkdown ends autolinks before Chinese quotation marks", async () => {
	const html = await renderMarkdown(
		"他说“看 https://example.com”然后走了，见 https://example.com/a‘说明’结束。",
	);

	assert.match(
		html,
		/<a href="https:\/\/example\.com"[^>]*>https:\/\/example\.com<\/a>”然后走了/,
	);
	assert.match(
		html,
		/<a href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>‘说明’结束。/,
	);
});

test("renderMarkdown keeps the href prefix of www autolinks", async () => {
	const html = await renderMarkdown("见 www.example.com，中文");

	assert.match(
		html,
		/<a href="http:\/\/www\.example\.com"[^>]*>www\.example\.com<\/a>，中文/,
	);
});

test("renderMarkdown keeps Chinese path text and ASCII punctuation in autolinks", async () => {
	const html = await renderMarkdown(
		"https://zh.wikipedia.org/wiki/中文 与 https://example.com/a?x=1,2 与 [doc](https://example.com/a，b) 与 https://example.com/a?q=值，说明",
	);

	assert.match(
		html,
		/href="https:\/\/zh\.wikipedia\.org\/wiki\/%E4%B8%AD%E6%96%87"/,
	);
	assert.match(html, /href="https:\/\/example\.com\/a\?x=1,2"/);
	assert.match(html, /href="https:\/\/example\.com\/a%EF%BC%8Cb"/);
	assert.match(
		html,
		/<a href="https:\/\/example\.com\/a\?q=%E5%80%BC"[^>]*>https:\/\/example\.com\/a\?q=值<\/a>，说明/,
	);
});
