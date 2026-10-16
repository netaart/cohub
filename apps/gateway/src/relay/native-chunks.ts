import { createHash } from "node:crypto";
import { nativeRuntimeEventSchema, type NativeRuntimeEvent } from "@cohub/protocol";

export const NATIVE_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const NATIVE_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
const NATIVE_UPLOAD_IDLE_MS = 30_000;
type Chunk = { requestId: string; index: number; totalBytes: number; sha256: string; data: string };
type Upload = { requestId: string; index: number; totalBytes: number; sha256: string; received: number; chunks: Buffer[]; updatedAt: number };

/** A connection owns one upload. No native event escapes until all bytes are validated. */
export class NativeChunkAssembler {
  private upload: Upload | null = null;

  clear(): void { this.upload = null; }

  expire(now = Date.now()): string | null {
    if (!this.upload || now - this.upload.updatedAt < NATIVE_UPLOAD_IDLE_MS) return null;
    const requestId = this.upload.requestId;
    this.clear();
    return requestId;
  }

  accept(chunk: Chunk): NativeRuntimeEvent | null {
    if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index > 31) throw new Error("Invalid native chunk index");
    if (!Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes <= 0 || chunk.totalBytes > NATIVE_UPLOAD_MAX_BYTES) throw new Error("Native upload exceeds the 256 MiB limit");
    if (!/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error("Invalid native upload checksum");
    if (chunk.data.length > Math.ceil(NATIVE_CHUNK_MAX_BYTES / 3) * 4 || chunk.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data)) throw new Error("Invalid native chunk base64 encoding or size");
    const bytes = Buffer.from(chunk.data, "base64");
    if (!bytes.length || bytes.length > NATIVE_CHUNK_MAX_BYTES || bytes.toString("base64") !== chunk.data) throw new Error("Invalid native chunk bytes or encoding");
    const pending = this.upload;
    if (pending && pending.requestId !== chunk.requestId) throw new Error("Another native upload is already in progress");
    if (chunk.index !== (pending?.index ?? 0)) throw new Error("Native chunk sequence index mismatch");
    if (pending && (pending.totalBytes !== chunk.totalBytes || pending.sha256 !== chunk.sha256)) throw new Error("Native upload metadata changed");
    const upload = pending ?? { requestId: chunk.requestId, index: 0, totalBytes: chunk.totalBytes, sha256: chunk.sha256, received: 0, chunks: [], updatedAt: Date.now() };
    if (upload.received + bytes.length > upload.totalBytes) throw new Error("Native upload exceeds declared total bytes");
    if (chunk.index === 31 && upload.received + bytes.length < upload.totalBytes) throw new Error("Native upload exceeds the 32 chunk limit");
    upload.chunks.push(bytes); upload.received += bytes.length; upload.index++; upload.updatedAt = Date.now();
    this.upload = upload;
    if (upload.received !== upload.totalBytes) return null;
    const complete = Buffer.concat(upload.chunks, upload.received);
    if (createHash("sha256").update(complete).digest("hex") !== upload.sha256) throw new Error("Native upload checksum mismatch");
    // Fatal UTF-8 decoding avoids silently replacing corrupt byte sequences.
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(complete));
    const event = nativeRuntimeEventSchema.parse(value);
    this.clear();
    return event;
  }
}
