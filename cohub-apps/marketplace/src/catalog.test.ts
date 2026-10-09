import assert from "node:assert/strict";
import { test } from "node:test";
import { MarketplaceCatalogSchema, ManifestSchema, isPermissionError, parseCatalog, toInstalledApp, unclaimedFileHandlers } from "./catalog";

const id = "123e4567-e89b-42d3-a456-426614174000";
const entry = { id, ref: "tzwm/cohub/task-browser", name: "Task Browser", url: "https://cdn.example.com/task-browser/index.html" };

test("catalog validation rejects malformed app metadata", () => {
  assert.throws(() => parseCatalog({ format: "cohub.app-marketplace", version: 1, apps: [{ ...entry, id: "not-an-id" }] }));
  assert.throws(() => parseCatalog({ format: "cohub.app-marketplace", version: 1, apps: [{ ...entry, url: "javascript:alert(1)" }] }));
  assert.throws(() => parseCatalog({ format: "cohub.app-marketplace", version: 1, apps: [{ ...entry, ref: "not a ref" }] }));
  assert.throws(() => parseCatalog({ format: "cohub.app-marketplace", version: 1, apps: [{ ...entry, ref: "tzwm/cohub/Task-Browser" }] }));
});

test("catalog validation accepts world-style space slugs", () => {
  const withUnderscore = { ...entry, ref: "yuyuyzl/world_01ky9kvh1xbv5keyf5k41grr0g/shiroko-profile" };
  const parsed = parseCatalog({ format: "cohub.app-marketplace", version: 1, apps: [withUnderscore] });
  assert.equal(parsed[0]?.ref, "yuyuyzl/world_01ky9kvh1xbv5keyf5k41grr0g/shiroko-profile");
  const withUuid = { ...entry, ref: "blahaj/69e5cb7e-c7a9-402e-a576-755ba09f200a/thirteenth-station" };
  assert.equal(parseCatalog({ format: "cohub.app-marketplace", version: 1, apps: [withUuid] })[0]?.ref, "blahaj/69e5cb7e-c7a9-402e-a576-755ba09f200a/thirteenth-station");
});

test("marketplace entries convert into a manifest-compatible installed app", () => {
  const app = toInstalledApp(MarketplaceCatalogSchema.parse({ format: "cohub.app-marketplace", version: 1, apps: [entry] }).apps[0]);
  assert.equal(ManifestSchema.parse({ format: "cohub.space-apps", version: 1, apps: [app] }).apps[0]?.source.type, "marketplace");
});

test("permission errors are separated from data errors", () => {
  assert.equal(isPermissionError({ status: 403 }), true);
  assert.equal(isPermissionError(new Error("catalog unavailable")), false);
});

test("installed Apps keep unknown fields, and install claims only free file types", () => {
  const [listed] = parseCatalog({ format: "cohub.app-marketplace", version: 1, apps: [entry] });
  assert.ok(listed);
  const manifest = ManifestSchema.parse({
    format: "cohub.space-apps",
    version: 1,
    future: true,
    apps: [{ ...toInstalledApp(listed, undefined, [".board"]), pinned: true }],
  });
  assert.equal((manifest as Record<string, unknown>).future, true);
  assert.equal((manifest.apps[0] as Record<string, unknown>).pinned, true);
  assert.deepEqual(manifest.apps[0]?.opens, [".board"]);
  assert.deepEqual(unclaimedFileHandlers(manifest, [".board", "BOARD", ".md", "MD", "no pe", 1]), [".md"]);
  assert.deepEqual(unclaimedFileHandlers(manifest, undefined), []);
  const disabled = { ...manifest, apps: manifest.apps.map((app) => ({ ...app, enabled: false })) };
  assert.deepEqual(unclaimedFileHandlers(disabled, [".board"]), [".board"]);
  assert.equal("opens" in toInstalledApp(listed), false);
});
