import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildFileSnapshot,
	fileCategory,
	fileMetaLine,
	fileStem,
	fileTypeLabel,
	splitFrontmatter,
} from "../../src/board/model/file-preview.js";

const facts = (
	content: string,
	path = "docs/notes.md",
	mimeType = "text/markdown",
) => buildFileSnapshot({ path, content, mimeType });

test("standard YAML frontmatter yields title, cover and excerpt", () => {
	const snapshot = facts(
		"---\ntitle: My Doc\ncover: ./cover.png\n---\n\n# Heading\n\nBody text here.",
	);
	assert.equal(snapshot.title, "My Doc");
	assert.equal(snapshot.coverPath, "docs/cover.png");
	assert.equal(snapshot.excerpt, "Heading\nBody text here.");
});

test("BOM, leading blanks and trailing fence whitespace still split", () => {
	assert.equal(
		facts("\uFEFF---\ntitle: BOM Doc\n---\nBody").title,
		"BOM Doc",
	);
	assert.equal(facts("\n\n---\ntitle: X\n---\nBody").title, "X");
	assert.equal(facts("---\ntitle: X\n--- \nBody").title, "X");
	assert.equal(facts("---\ntitle: X\n...\nBody").title, "X");
});

test("TOML +++ frontmatter is recognised", () => {
	assert.equal(facts('+++\ntitle = "Hugo"\n+++\nBody').title, "Hugo");
});

test("name / label / heading frontmatter keys become the title", () => {
	assert.equal(facts("---\nname: Agent Skill\n---\nBody").title, "Agent Skill");
	assert.equal(facts("---\nlabel: Labeled\n---\nBody").title, "Labeled");
	assert.equal(facts("---\nheading: Head\n---\nBody").title, "Head");
});

test("block scalar indicators are not used as titles", () => {
	const snapshot = facts("---\ntitle: >\n  Long title\n---\nBody");
	assert.equal(snapshot.title, "notes");
	assert.equal(snapshot.excerpt, "Body");
});

test("H1 is promoted to title and removed from the excerpt", () => {
	const snapshot = facts("# Real Heading\n\nSome body");
	assert.equal(snapshot.title, "Real Heading");
	assert.equal(snapshot.excerpt, "Some body");
});

test("setext H1 is promoted to title", () => {
	const snapshot = facts("Real Heading\n============\n\nSome body");
	assert.equal(snapshot.title, "Real Heading");
	assert.equal(snapshot.excerpt, "Some body");
});

test("filename stem is the last-resort title and drops the extension", () => {
	assert.equal(fileStem("docs/notes.md"), "notes");
	assert.equal(fileStem(".npmrc"), ".npmrc");
	assert.equal(
		buildFileSnapshot({ path: "src/a.ts", mimeType: "text/typescript" }).title,
		"a",
	);
});

test("nested image.src is accepted as a cover", () => {
	const snapshot = facts("---\nimage:\n  src: ./hero.png\n---\nBody");
	assert.equal(snapshot.coverPath, "docs/hero.png");
});

test("bare image values that are not paths are ignored", () => {
	const snapshot = facts("---\nimage: landscape\n---\nBody");
	assert.equal(snapshot.coverPath, undefined);
});

test("json files take name/description/cover and skip raw excerpt", () => {
	const snapshot = buildFileSnapshot({
		path: "package.json",
		mimeType: "application/json",
		content:
			'{\n  "name": "cohub",\n  "description": "A workspace.",\n  "cover": "./icon.png",\n  "version": "1.0.0"\n}',
	});
	assert.equal(snapshot.title, "cohub");
	assert.equal(snapshot.excerpt, "A workspace.");
	assert.equal(snapshot.coverPath, "icon.png");
	assert.equal(fileCategory("package.json", "application/json"), "data");
});

test("code files excerpt the leading comment and keep asterisks", () => {
	const snapshot = buildFileSnapshot({
		path: "src/a.ts",
		mimeType: "text/typescript",
		content: "/** docs for the module */\nexport const a = 1;",
	});
	assert.equal(snapshot.title, "a");
	assert.equal(snapshot.excerpt, "docs for the module");
});

test("unterminated frontmatter stays in the body rather than leaking as excerpt noise", () => {
	const { frontmatter, body } = splitFrontmatter("---\ntitle: X\nno close");
	assert.equal(frontmatter, null);
	assert.match(body, /^---/);
});

test("meta line joins type and size", () => {
	assert.equal(fileTypeLabel("docs/notes.md"), "MD");
	assert.equal(fileTypeLabel("data/rows.json"), "JSON");
	assert.equal(fileTypeLabel("Makefile"), "MAKEFILE");
	assert.equal(fileMetaLine("docs/notes.md", 12_288), "MD · 12 KB");
	assert.equal(fileMetaLine("docs/notes.md", undefined), "MD");
});
