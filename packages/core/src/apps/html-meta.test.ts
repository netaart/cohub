import assert from "node:assert/strict";
import {
  collectLocalPageAssetRefs,
  emptyHtmlPageMeta,
  extractHtmlPageMeta,
  fillIconFromSiteFiles,
  htmlLangToOgLocale,
  normalizeHtmlLang,
  normalizeLocalPageAssetRef,
} from "./html-meta.js";

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <title>  Launch Board </title>
    <meta name="description" content="Ship demos from Cohub Spaces." />
    <meta name="theme-color" content="#c76b3a" />
    <meta property="og:image" content="/cover.png" />
    <link rel="icon" href="./favicon.svg" sizes="any" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />
  </head>
  <body></body>
</html>`;

const meta = extractHtmlPageMeta(html);
assert.equal(meta.title, "Launch Board");
assert.equal(meta.description, "Ship demos from Cohub Spaces.");
assert.equal(meta.image, "/cover.png");
assert.equal(meta.icon, "/apple-touch-icon.png");
assert.equal(meta.lang, "zh-CN");
assert.equal(meta.themeColor, "#c76b3a");
assert.equal(htmlLangToOgLocale(meta.lang), "zh_CN");
assert.equal(meta.surface, null);

assert.equal(
  extractHtmlPageMeta('<head><meta name="cohub:surface" content="Overlay"></head>').surface,
  "overlay",
);
assert.equal(
  extractHtmlPageMeta('<head><meta name="cohub:surface" content="popup"></head>').surface,
  null,
);

const filled = fillIconFromSiteFiles(
  { ...emptyHtmlPageMeta() },
  ["index.html", "assets/app.js", "favicon.ico"],
);
assert.equal(filled.icon, "favicon.ico");

const entities = extractHtmlPageMeta(
  `<html lang="en"><head><title>A &amp; B</title><meta name="description" content="Hello&nbsp;world"></head></html>`,
);
assert.equal(entities.title, "A & B");
assert.equal(entities.description, "Hello world");
assert.equal(entities.lang, "en");

assert.equal(normalizeHtmlLang("zh_CN"), "zh-CN");
assert.equal(normalizeHtmlLang("EN-us"), "en-US");
assert.equal(normalizeHtmlLang("not a lang!!!"), null);

assert.equal(normalizeLocalPageAssetRef("./assets/icon.png"), "assets/icon.png");
assert.equal(normalizeLocalPageAssetRef("/favicon.svg"), "favicon.svg");
assert.equal(normalizeLocalPageAssetRef("https://cdn.example/a.png"), null);
assert.equal(normalizeLocalPageAssetRef("../secret.png"), null);

const packed = collectLocalPageAssetRefs({
  ...emptyHtmlPageMeta(),
  icon: "./favicon.svg",
  image: "https://cdn.example/cover.png",
});
assert.deepEqual(packed, ["favicon.svg"]);

const fallbacks = collectLocalPageAssetRefs(emptyHtmlPageMeta());
assert.ok(fallbacks.includes("favicon.ico"));
assert.ok(fallbacks.includes("favicon.svg"));

const fromOgLocale = extractHtmlPageMeta(
  `<html><head><meta property="og:locale" content="ja_JP"><title>Hi</title></head></html>`,
);
assert.equal(fromOgLocale.lang, "ja-JP");

assert.deepEqual(
  extractHtmlPageMeta('<head><meta name="cohub:file-handlers" content="board, .MD nope!"></head>').fileHandlers,
  [".board", ".md"],
);
assert.deepEqual(extractHtmlPageMeta("<head><title>x</title></head>").fileHandlers, []);
