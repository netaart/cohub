import assert from "node:assert/strict";
import test from "node:test";
import { clearTaskCache, readTaskCache, writeTaskCache } from "./task-cache.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

const identity = { appId: "app-1", viewerId: "user-1" };
const page = {
  tasks: [],
  pageInfo: { hasMore: false, nextCursor: null },
};

test("stores and restores a query page by identity and key", () => {
  writeTaskCache(identity, "space:space-1:all", page);
  const cached = readTaskCache(identity, "space:space-1:all");
  assert.deepEqual(cached?.tasks, []);
  assert.deepEqual(cached?.pageInfo, page.pageInfo);
  assert.equal(readTaskCache(identity, "space:space-2:all"), null);
});

test("clears one query without touching another", () => {
  writeTaskCache(identity, "space:space-1:all", page);
  writeTaskCache(identity, "space:space-2:all", page);
  clearTaskCache(identity, "space:space-1:all");
  assert.equal(readTaskCache(identity, "space:space-1:all"), null);
  assert.ok(readTaskCache(identity, "space:space-2:all"));
  storage.clear();
});
