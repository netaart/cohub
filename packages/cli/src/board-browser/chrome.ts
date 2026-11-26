import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

/** Pinned, so every machine that downloads draws Boards with the same engine. */
export const BOARD_CHROME_VERSION = "158.0.8127.88";

const PLATFORMS: Record<string, string> = {
  "linux-x64": "linux64",
  "linux-arm64": "linux-arm64",
  "darwin-x64": "mac-x64",
  "darwin-arm64": "mac-arm64",
  "win32-x64": "win64",
  "win32-ia32": "win32",
};

function chromePlatform(): string | null {
  return PLATFORMS[`${process.platform}-${process.arch}`] ?? null;
}

function cachedChrome(platform: string): string {
  const name = `chrome-headless-shell-${platform}`;
  return join(homedir(), ".cache", "cohub", "chrome", BOARD_CHROME_VERSION, name, `chrome-headless-shell${process.platform === "win32" ? ".exe" : ""}`);
}

export function findBoardBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env.COHUB_CHROME?.trim();
  if (named) return existsSync(named) ? named : null;
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : process.platform === "win32"
      ? [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].flatMap((root) => root ? [join(root, "Google/Chrome/Application/chrome.exe"), join(root, "Microsoft/Edge/Application/msedge.exe")] : [])
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].flatMap((name) =>
          (env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, name)));
  const platform = chromePlatform();
  return [...candidates, ...(platform ? [cachedChrome(platform)] : [])].find((path) => existsSync(path)) ?? null;
}

export async function boardBrowser(signal?: AbortSignal): Promise<string> {
  const found = findBoardBrowser();
  if (found) return found;
  if (process.env.COHUB_CHROME?.trim()) throw new Error(`COHUB_CHROME points to ${process.env.COHUB_CHROME}, which does not exist.`);
  const platform = chromePlatform();
  if (!platform) throw new Error(`Board scripts need Chrome, and none is published for ${process.platform}/${process.arch}. Install Chrome or Chromium, or set COHUB_CHROME to its path.`);
  const target = cachedChrome(platform);
  const root = dirname(dirname(target));
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, ".download-"));
  try {
    const url = `https://storage.googleapis.com/chrome-for-testing-public/${BOARD_CHROME_VERSION}/${platform}/chrome-headless-shell-${platform}.zip`;
    const archive = join(staging, "chrome.zip");
    await download(url, archive, signal);
    await unzip(archive, staging);
    try {
      await rename(join(staging, `chrome-headless-shell-${platform}`), dirname(target));
    } catch (error) {
      if (!existsSync(target)) throw error;
    }
    process.stderr.write("Chrome is ready.\n");
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function download(url: string, path: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]) : AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Chrome could not be downloaded (${response.status}) from ${url}.`);
  const total = Number(response.headers.get("content-length")) || 0;
  const expected = /md5=([^,\s]+)/.exec(response.headers.get("x-goog-hash") ?? "")?.[1];
  process.stderr.write(`Board scripts run in a browser; downloading Chrome ${BOARD_CHROME_VERSION}${total ? ` (${Math.round(total / 1024 ** 2)} MB)` : ""} once…\n`);
  const md5 = createHash("md5");
  let received = 0;
  let reported = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      md5.update(chunk);
      received += chunk.length;
      const tenth = total ? Math.floor((received / total) * 10) : 0;
      if (tenth > reported && tenth < 10) {
        reported = tenth;
        process.stderr.write(`  ${tenth * 10}%\n`);
      }
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), progress, createWriteStream(path));
  if (total && received !== total) throw new Error("The Chrome download was cut short; try again.");
  if (expected && md5.digest("base64") !== expected) throw new Error("The Chrome download is corrupt; try again.");
}

export async function unzip(archive: string, into: string): Promise<void> {
  const file = await open(archive, "r");
  try {
    const { size } = await file.stat();
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) throw new Error("The Chrome archive is not a zip file.");
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (offset === 0xffffffff || count === 0xffff) throw new Error("The Chrome archive needs zip64, which is not supported.");
    const directory = Buffer.alloc(length);
    await file.read(directory, 0, length, offset);
    const base = normalize(into) + sep;
    // Links are made last, so no file is written through one.
    const links: Array<{ path: string; link: string }> = [];
    for (let at = 0, index = 0; index < count; index++) {
      if (directory.readUInt32LE(at) !== 0x02014b50) throw new Error("The Chrome archive is damaged.");
      const madeBy = directory.readUInt16LE(at + 4) >> 8;
      const method = directory.readUInt16LE(at + 10);
      const compressed = directory.readUInt32LE(at + 20);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const attributes = directory.readUInt32LE(at + 38);
      const local = directory.readUInt32LE(at + 42);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      const path = normalize(join(into, name));
      if (!path.startsWith(base)) throw new Error(`The Chrome archive names a path outside it: ${name}`);
      if (name.endsWith("/")) {
        await mkdir(path, { recursive: true });
        continue;
      }
      const header = Buffer.alloc(30);
      await file.read(header, 0, 30, local);
      const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const mode = madeBy === 3 ? (attributes >>> 16) & 0xffff : 0;
      await mkdir(dirname(path), { recursive: true });
      const body = createReadStream(archive, { start, end: start + compressed - 1 });
      if ((mode & 0o170000) === 0o120000) {
        const chunks: Buffer[] = [];
        for await (const chunk of method === 8 ? body.pipe(createInflateRaw()) : body) chunks.push(chunk as Buffer);
        const link = Buffer.concat(chunks).toString("utf8");
        if (isAbsolute(link) || !resolve(dirname(path), link).startsWith(base)) throw new Error(`The Chrome archive links outside it: ${name}`);
        links.push({ path, link });
        continue;
      }
      if (method !== 0 && method !== 8) throw new Error(`The Chrome archive uses an unsupported compression: ${name}`);
      if (method === 8) await pipeline(body, createInflateRaw(), createWriteStream(path));
      else await pipeline(body, createWriteStream(path));
      if (mode & 0o777) await chmod(path, mode & 0o777);
    }
    for (const { path, link } of links) await symlink(link, path);
  } finally {
    await file.close();
  }
}
