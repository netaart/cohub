import assert from "node:assert/strict";
import { test } from "node:test";
import { createFrameView } from "../src/app/view.ts";
import { FakeElement } from "./helpers.ts";

function find(root: FakeElement, className: string): FakeElement {
  for (const child of root.children) {
    if (child.className === className) return child;
    const found = find(child, className);
    if (found.className === className) return found;
  }
  return new FakeElement();
}

test("setLanguage rewrites the folder line", () => {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => new FakeElement(),
  } as unknown as Document;
  try {
    const root = new FakeElement();
    const view = createFrameView(root as unknown as HTMLElement, "en");
    view.setFile("intro.abc", "intro.abc", false);
    view.showEditor();

    const path = find(root, "frame-path");
    const tag = find(root, "frame-tag");
    assert.equal(path.textContent, "Space root");
    assert.equal(tag.hidden, true);

    view.setLanguage("zh");

    assert.equal(path.textContent, "Space 根目录");
    assert.equal(tag.hidden, true);
  } finally {
    if (previous === undefined) delete (globalThis as { document?: Document }).document;
    else globalThis.document = previous;
  }
});

test("the folder line names the working Space beside the folder", () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeElement() } as unknown as Document;
  try {
    const root = new FakeElement();
    const view = createFrameView(root as unknown as HTMLElement, "en");
    view.setFile("intro.abc", "scores/intro.abc", true);
    view.setSpaceName("My Space");
    assert.equal(find(root, "frame-path").textContent, "My Space · scores");
    view.setSpaceName(null);
    assert.equal(find(root, "frame-path").textContent, "scores");
  } finally {
    if (previous === undefined) delete (globalThis as { document?: Document }).document;
    else globalThis.document = previous;
  }
});
