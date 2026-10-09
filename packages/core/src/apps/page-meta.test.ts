import assert from "node:assert/strict";
import {
  isWeakAppPageMediaRef,
  materializeHtmlPageMeta,
  mergeAppPageMeta,
  resolveAppPageAssetRef,
  resolveAppPageMediaAgainstContentUrl,
  appTitleFromMeta,
} from "./page-meta.js";

const toPublicUrl = (key: string) => `https://cdn.example/${key}`;

assert.equal(
  resolveAppPageAssetRef("favicon.svg", "w/space/demo/abc/index.html", toPublicUrl),
  "https://cdn.example/w/space/demo/abc/favicon.svg",
);
assert.equal(
  resolveAppPageAssetRef("/assets/icon.png", "w/space/demo/abc/index.html", toPublicUrl),
  "https://cdn.example/w/space/demo/abc/assets/icon.png",
);
assert.equal(
  resolveAppPageAssetRef("https://img.example/a.png", "w/space/demo/abc/index.html", toPublicUrl),
  "https://img.example/a.png",
);
assert.equal(
  resolveAppPageAssetRef("http://img.example/a.png", "w/space/demo/abc/index.html", toPublicUrl),
  null,
);
assert.equal(
  resolveAppPageAssetRef("https://localhost/a.png", "w/space/demo/abc/index.html", toPublicUrl),
  null,
);
assert.equal(
  resolveAppPageAssetRef("https://10.0.0.8/a.png", "w/space/demo/abc/index.html", toPublicUrl),
  null,
);
assert.equal(
  resolveAppPageAssetRef("https://169.254.169.254/latest/meta-data", "w/space/demo/abc/index.html", toPublicUrl),
  null,
);
assert.equal(
  resolveAppPageAssetRef("../secret.png", "w/space/demo/abc/index.html", toPublicUrl),
  null,
);
assert.equal(
  resolveAppPageAssetRef(
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
    "w/space/demo/abc/index.html",
    toPublicUrl,
  ),
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
);
assert.equal(
  resolveAppPageMediaAgainstContentUrl(
    "/favicon.svg",
    "https://works.example/dev/w/space/demo/abc/index.html",
  ),
  "https://works.example/dev/w/space/demo/abc/favicon.svg",
);
assert.equal(isWeakAppPageMediaRef("/favicon.svg"), true);
assert.equal(isWeakAppPageMediaRef("https://cdn.example/a.png"), false);

const extracted = materializeHtmlPageMeta(
  {
    title: "Board",
    description: "Hello",
    icon: "favicon.ico",
    image: "https://img.example/cover.png",
    lang: "zh-CN",
    themeColor: "#c76b3a",
    surface: "overlay",
    sourcePath: "index.html",
  },
  "w/space/demo/abc/index.html",
  toPublicUrl,
  "2026-01-01T00:00:00.000Z",
);
assert.equal(extracted.icon, "https://cdn.example/w/space/demo/abc/favicon.ico");
assert.equal(extracted.image, "https://img.example/cover.png");
assert.equal(extracted.lang, "zh-CN");
assert.equal(extracted.themeColor, "#c76b3a");

// Existing effective fields win; extract only fills blanks and always refreshes snapshot.
const merged = mergeAppPageMeta(
  { presentation: { hideCohubBar: true }, title: "Manual Title" },
  extracted,
);
assert.equal(merged?.title, "Manual Title");
assert.equal(merged?.description, "Hello");
assert.equal((merged?.presentation as { hideCohubBar?: boolean })?.hideCohubBar, true);
assert.equal((merged?.extracted as { title?: string })?.title, "Board");
assert.equal((merged?.extracted as { sourcePath?: string })?.sourcePath, "index.html");

const filled = mergeAppPageMeta({ presentation: { hideCohubBar: true } }, extracted);
assert.equal(filled?.title, "Board");

const promoted = mergeAppPageMeta({ name: "Legacy Name" }, extracted);
assert.equal(promoted?.title, "Legacy Name");
assert.equal(promoted?.name, undefined);

// Weak relative leftovers are upgraded by a solid extracted absolute URL.
const upgraded = mergeAppPageMeta({ icon: "/favicon.svg" }, extracted);
assert.equal(upgraded?.icon, "https://cdn.example/w/space/demo/abc/favicon.ico");

// A declared surface fills presentation.surface; the publisher's value wins and
// the default `window` stays implicit.
assert.equal((filled?.presentation as { surface?: string })?.surface, "overlay");
assert.equal(
  (mergeAppPageMeta({ presentation: { surface: "window" } }, extracted)?.presentation as { surface?: string })
    ?.surface,
  "window",
);
assert.equal(
  mergeAppPageMeta({}, { ...extracted, surface: "window" })?.presentation,
  undefined,
);
assert.equal((merged?.extracted as { surface?: string })?.surface, "overlay");

// A surface written by extraction follows the page across publishes: it can be
// changed or removed, while a value that differs from the last snapshot is kept.
const published = mergeAppPageMeta({}, extracted);
assert.equal((published?.presentation as { surface?: string })?.surface, "overlay");
const toWindow = mergeAppPageMeta(published, { ...extracted, surface: "window" });
assert.equal(toWindow?.presentation, undefined);
const removed = mergeAppPageMeta(published, { ...extracted, surface: null });
assert.equal(removed?.presentation, undefined);
const overridden = mergeAppPageMeta(
  { presentation: { surface: "overlay" }, extracted: { surface: "window" } },
  { ...extracted, surface: null },
);
assert.equal((overridden?.presentation as { surface?: string })?.surface, "overlay");
const keepsSiblings = mergeAppPageMeta(
  { presentation: { hideCohubBar: true, surface: "overlay" }, extracted: { surface: "overlay" } },
  { ...extracted, surface: null },
);
assert.deepEqual(keepsSiblings?.presentation, { hideCohubBar: true });

// Every extracted field follows the page the same way surface does: a value
// extraction wrote last time is updated or dropped, one that differs from the snapshot is kept.
const first = mergeAppPageMeta({}, extracted);
const retitled = mergeAppPageMeta(first, {
  ...extracted,
  title: "Board v2",
  description: null,
  themeColor: "#000000",
});
assert.equal(retitled?.title, "Board v2");
assert.equal(retitled?.description, undefined);
assert.equal(retitled?.themeColor, "#000000");
const handSet = mergeAppPageMeta(
  { ...first, title: "Manual Title", description: "Manual blurb" },
  { ...extracted, title: "Board v2", description: null },
);
assert.equal(handSet?.title, "Manual Title");
assert.equal(handSet?.description, "Manual blurb");

// Records from before snapshots existed: a weak relative icon still upgrades,
// and stays put when the new page declares none; a solid hand-set icon is kept.
assert.equal(
  mergeAppPageMeta({ icon: "/favicon.svg" }, { ...extracted, icon: null })?.icon,
  "/favicon.svg",
);
assert.equal(
  mergeAppPageMeta({ icon: "https://cdn.example/own.png" }, extracted)?.icon,
  "https://cdn.example/own.png",
);

assert.equal(appTitleFromMeta({ title: "A", name: "B" }, "fallback"), "A");
assert.equal(appTitleFromMeta({ name: "B" }, "fallback"), "B");
assert.equal(appTitleFromMeta(null, "fallback"), "fallback");

const withHandlers = { ...extracted, fileHandlers: [".board"] };
const handled = mergeAppPageMeta({}, withHandlers);
assert.deepEqual(handled?.fileHandlers, [".board"]);
assert.deepEqual((handled?.extracted as { fileHandlers?: string[] })?.fileHandlers, [".board"]);
assert.deepEqual(mergeAppPageMeta(handled, { ...extracted, fileHandlers: [".board", ".md"] })?.fileHandlers, [".board", ".md"]);
assert.equal(mergeAppPageMeta(handled, { ...extracted, fileHandlers: [] })?.fileHandlers, undefined);
assert.deepEqual(mergeAppPageMeta({ ...handled, fileHandlers: ["MD"] }, { ...extracted, fileHandlers: [] })?.fileHandlers, [".md"]);
assert.deepEqual(materializeHtmlPageMeta({ ...extracted, fileHandlers: undefined }, null, toPublicUrl).fileHandlers, []);
