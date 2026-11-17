import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CohubClient } from "@neta-art/cohub";
import { compileModule } from "svelte/compiler";
import { transformWithOxc } from "vite";
import type { CampSession } from "../net/session.ts";
import type { World } from "./world.ts";

const file = new URL("./media.svelte.ts", import.meta.url);
const { code: plain } = await transformWithOxc(readFileSync(file, "utf8"), file.pathname);
const code = compileModule(plain, { filename: file.pathname, generate: "client" }).js.code
  .replace(/from ['"]([^'"]+)['"]/g, (_match, specifier: string) => {
    const url = specifier.startsWith(".") ? new URL(specifier, file).href : import.meta.resolve(specifier);
    return `from ${JSON.stringify(url)}`;
  });
const { CampMedia } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as typeof import("./media.svelte.ts");

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

for (const device of ["microphone", "camera"] as const) {
  test(`leaving before permission resolves never opens the ${device}`, async () => {
    const permission = deferred<string>();
    const session = {} as CampSession;
    const client = { app: { devices: { request: () => permission.promise } } } as unknown as CohubClient;
    const media = new CampMedia(client, {} as World, {
      session: () => session, beforeGrant() {}, afterGrant() {},
      notice() { assert.fail("A cancelled request must not surface a device error"); },
    });
    const pending = device === "camera" ? media.toggleCamera() : media.toggleMic();
    media.stop();
    permission.resolve("granted");
    await pending;
    assert.equal(media.mic, false);
    assert.equal(media.localCamera, null);
  });
}

test("a camera stream arriving after leave has every track stopped", async () => {
  const stream = deferred<MediaStream>();
  const started = deferred<void>();
  const previous = Object.getOwnPropertyDescriptor(globalThis.navigator, "mediaDevices");
  let stopped = 0;
  Object.defineProperty(globalThis.navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: () => { started.resolve(); return stream.promise; },
  } });
  const client = { app: { devices: { request: async () => "granted" } } } as unknown as CohubClient;
  const media = new CampMedia(client, {} as World, {
    session: () => session, beforeGrant() {}, afterGrant() {}, notice() {},
  });
  const session = {} as CampSession;
  try {
    const pending = media.toggleCamera();
    await started.promise;
    media.stop();
    stream.resolve({ getTracks: () => [{ stop: () => { stopped++; } }, { stop: () => { stopped++; } }] } as unknown as MediaStream);
    await pending;
    assert.equal(stopped, 2);
    assert.equal(media.mic, false);
  } finally {
    if (previous) Object.defineProperty(globalThis.navigator, "mediaDevices", previous);
    else Reflect.deleteProperty(globalThis.navigator, "mediaDevices");
  }
});
