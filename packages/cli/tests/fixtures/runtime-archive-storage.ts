import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HttpError, RUNTIME_EXECUTION_RESOLVED_CODE, harnessArchiveIndexSchema, validateArchiveBoundary, type HarnessArchiveIndex } from "@neta-art/cohub";
import type { ArchiveTransport } from "../../src/runtime/archive-store.js";

/** Control plane receives metadata only; the injected object transport receives bytes. */
export async function archiveStorageFixture() {
  const objects = new Map<string, Buffer>();
  const versions = new Map<string, HarnessArchiveIndex>();
  const resolved = new Set<string>();
  let fail = false, receivedBytes = 0, prepares = 0;
  const transport: ArchiveTransport = {
    fetchObject: async (input, init) => {
      const key = new URL(String(input)).pathname.slice(1);
      if (init?.method === "PUT") {
        const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
        receivedBytes += bytes.length;
        assert.equal(createHash("sha256").update(bytes).digest("hex"), key);
        if (objects.has(key)) return new Response(null, { status: 412 });
        objects.set(key, bytes); return new Response(null, { status: 200 });
      }
      const bytes = objects.get(key);
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    },
    async prepareRuntimeArchive(index) {
      prepares++;
      if (fail) throw new Error("injected offline");
      if (resolved.has(index.turnId)) throw new HttpError("Execution was resolved", 409, { message: "Execution was resolved", code: RUNTIME_EXECUTION_RESOLVED_CODE });
      validateArchiveBoundary(index, index.parentTurnId ? versions.get(index.parentTurnId) ?? null : null);
      return { uploads: index.segments.filter((segment) => !objects.has(segment.sha256)).map((segment) => ({ segment, uploadUrl: `https://storage.test/${segment.sha256}` })) };
    },
    async commitRuntimeArchive(index) {
      for (const segment of index.segments) assert.equal(objects.get(segment.sha256)?.length, segment.sizeBytes);
      versions.set(index.turnId, harnessArchiveIndexSchema.parse(index));
      return { ready: true };
    },
    async getRuntimeArchive(_sessionId, turnId) {
      const index = versions.get(turnId);
      if (!index) throw new Error("archive pending");
      return { index, segments: index.segments.map((segment) => ({ segment, downloadUrl: `https://storage.test/${segment.sha256}` })) };
    },
  };
  return { transport, versions, objects, resolved, get prepares() { return prepares; }, get receivedBytes() { return receivedBytes; }, setOffline(value: boolean) { fail = value; }, async close() {} };
}
