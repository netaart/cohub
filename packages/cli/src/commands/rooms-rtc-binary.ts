import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

// Bumped by a PR from rtc-binaries-build.yml once the helper artifacts are on the CDN.
export const RTC_HELPER_VERSION: string = "v2.96.0";
const MAX_BINARY_BYTES = 128 * 1024 * 1024;

async function digest(path: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function readText(response: Response, limit: number) {
  if (!response.body) throw new Error("Empty RTC helper response");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new Error("RTC helper metadata exceeds the size limit");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(parts).toString("utf8");
}

export async function ensureRtcBinary(local?: string): Promise<string> {
  const override = local || process.env.COHUB_RTC_BIN?.trim();
  if (override) {
    if (!(await lstat(override)).isFile()) throw new Error("RTC helper must be a regular file");
    return resolve(override);
  }
  const platform = ({ linux: "linux", darwin: "darwin" } as Record<string, string>)[process.platform];
  const arch = ({ x64: "amd64", arm64: "arm64" } as Record<string, string>)[process.arch];
  if (!platform || !arch) throw new Error("Unsupported RTC helper platform; use --helper with a local binary");
  const version = process.env.COHUB_RTC_VERSION?.trim() || RTC_HELPER_VERSION;
  if (!version) throw new Error("No RTC helper release is pinned yet; use --helper or COHUB_RTC_VERSION with a published global release");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(version)) throw new Error("Invalid RTC helper version");
  const directory = join(homedir(), ".cache", "cohub", "rtc", version, `${platform}-${arch}`);
  const binary = join(directory, "cohub-rtc");
  const checksum = `${binary}.sha256`;
  const expected = await readFile(checksum, "utf8").catch(() => "");
  if (/^[a-f0-9]{64}$/.test(expected) && (await lstat(binary).catch(() => null))?.isFile() && await digest(binary) === expected) return binary;
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, ".download-"));
  const base = (process.env.COHUB_RTC_CDN_BASE_URL?.trim() || "https://public.cohub.live/rtc").replace(/\/+$/, "");
  const url = `${base}/${version}/cohub-rtc_${platform}_${arch}.gz`;
  const signal = AbortSignal.timeout(120_000);
  try {
    const manifest = await fetch(`${url}.sha256`, { signal });
    if (!manifest.ok) throw new Error(`RTC helper ${version} is unavailable (${manifest.status}); use --helper with a locally built cohub-rtc`);
    const text = await readText(manifest, 1024);
    const expectedArchive = text.trim().split(/\s+/)[0];
    if (!expectedArchive || !/^[a-f0-9]{64}$/.test(expectedArchive)) throw new Error("Invalid RTC helper checksum");
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(`RTC helper download failed (${response.status})`);
    let bytes = 0;
    const bound = () => new Transform({ transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > MAX_BINARY_BYTES ? new Error("RTC helper exceeds the size limit") : null, chunk);
    } });
    const archive = join(temporary, "archive.gz");
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), bound(), createWriteStream(archive, { flags: "wx" }), { signal });
    if (await digest(archive) !== expectedArchive) throw new Error("RTC helper checksum mismatch");
    for (const name of ["LICENSE", "NOTICE"]) {
      const response = await fetch(`${base}/${version}/${name}`, { signal });
      if (!response.ok) throw new Error(`RTC helper ${name} is unavailable (${response.status})`);
      const text = await readText(response, 64 * 1024);
      await writeFile(join(temporary, name), text, { flag: "wx" });
      await rename(join(temporary, name), join(directory, name));
    }
    const extracted = join(temporary, "cohub-rtc");
    bytes = 0;
    await pipeline(createReadStream(archive), createGunzip(), bound(), createWriteStream(extracted, { flags: "wx", mode: 0o700 }), { signal });
    await chmod(extracted, 0o700);
    const hash = await digest(extracted);
    await writeFile(join(temporary, "checksum"), hash, { flag: "wx" });
    await rename(extracted, binary);
    await rename(join(temporary, "checksum"), checksum);
    return binary;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
