import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type BoardMediaSpan, type BoardMediaState, parseBoardMediaSource } from "@neta-art/cohub/board";
import { createClient } from "./client.js";
import { downloadPublicAudio, downloadPublicVideo } from "./safe-remote-image.js";

const execFile = promisify(execFileCallback);

const CHUNK_SECONDS = 4;
const MAX_DECODE_FPS = 60;

async function ffmpeg(args: string[], signal?: AbortSignal) {
  try {
    return await execFile("ffmpeg", ["-v", "error", ...args], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, signal });
  } catch (error) {
    const cause = error as { code?: string; stderr?: string; message?: string };
    if (cause.code === "ENOENT") throw new Error("Exporting video and audio needs ffmpeg. Install ffmpeg and try again.");
    throw new Error(`ffmpeg failed: ${(cause.stderr ?? cause.message ?? "unknown error").trim().split("\n").slice(-4).join("\n")}`);
  }
}

export function createBoardMediaFiles(spaceId: string, dir: string, signal?: AbortSignal) {
  const files = new Map<string, Promise<string>>();
  const audible = new Map<string, Promise<boolean>>();
  const client = createClient();
  return {
    path(src: string, kind: "video" | "audio"): Promise<string> {
      let pending = files.get(src);
      if (!pending) {
        const path = join(dir, `media-${files.size}`);
        pending = (async () => {
          const source = parseBoardMediaSource(src);
          if (!source) throw new Error(`Invalid media source ${src}`);
          const { bytes } = source.kind === "file"
            ? { bytes: new Uint8Array(await (await client.space(spaceId).files.download(source.value)).blob.arrayBuffer()) }
            : await (kind === "video" ? downloadPublicVideo : downloadPublicAudio)(source.value);
          await writeFile(path, bytes);
          return path;
        })();
        files.set(src, pending);
      }
      return pending;
    },
    async audible(src: string, kind: "video" | "audio"): Promise<boolean> {
      let pending = audible.get(src);
      if (!pending) {
        pending = this.path(src, kind).then(async (path) => {
          const { stdout } = await execFile("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path], { signal });
          return stdout.trim().length > 0;
        });
        audible.set(src, pending);
      }
      return pending;
    },
  };
}

export type BoardMediaFiles = ReturnType<typeof createBoardMediaFiles>;

type Chunk = { src: string; start: number; fps: number; count: number; edge: number; dir: string };

export function createBoardVideoFrames(files: BoardMediaFiles, dir: string, options: { fps: number; signal?: AbortSignal }) {
  const chunks = new Map<string, Chunk>();
  let decoded = 0;

  function lookup(chunk: Chunk | undefined, time: number, edge: number): string | null {
    if (!chunk || edge > chunk.edge) return null;
    const index = chunk.count === 1 ? (Math.abs(time - chunk.start) < 1 ? 0 : -1) : Math.round(((time - chunk.start) * chunk.fps) / 1000);
    return index >= 0 && index < chunk.count ? join(chunk.dir, `${String(index + 1).padStart(5, "0")}.jpg`) : null;
  }

  async function decode(state: BoardMediaState, rate: number, edge: number): Promise<Chunk> {
    const path = await files.path(state.src, "video");
    const previous = chunks.get(state.id);
    if (previous) await rm(previous.dir, { recursive: true, force: true });
    const chunkDir = join(dir, `frames-${decoded++}`);
    await mkdir(chunkDir);
    const fps = rate > 0 ? Math.min(MAX_DECODE_FPS, Math.max(1, Math.ceil(options.fps * rate))) : 0;
    const scale = `scale=w=${edge}:h=${edge}:force_original_aspect_ratio=decrease`;
    await ffmpeg([
      "-ss", (state.time / 1000).toFixed(3), "-i", path,
      ...(fps ? ["-t", String(CHUNK_SECONDS), "-vf", `fps=${fps},${scale}`] : ["-frames:v", "1", "-vf", scale]),
      "-q:v", "3", join(chunkDir, "%05d.jpg"),
    ], options.signal);
    const count = fps ? Math.max(1, Math.round(CHUNK_SECONDS * fps)) : 1;
    const chunk = { src: state.src, start: state.time, fps: fps || 1, count, edge, dir: chunkDir };
    chunks.set(state.id, chunk);
    return chunk;
  }

  return {
    async frame(state: BoardMediaState, rate: number, edge: number): Promise<Uint8Array | null> {
      const current = chunks.get(state.id);
      let file = current?.src === state.src ? lookup(current, state.time, edge) : null;
      if (!file) file = lookup(await decode(state, rate, edge), state.time, edge);
      return file ? new Uint8Array(await readFile(file).catch(() => Buffer.alloc(0))) : null;
    },
  };
}

function volumeExpression(span: BoardMediaSpan): string {
  const points = span.volume.map((point) => ({ t: (point.at - span.start) / 1000, v: point.value }));
  if (points.every((point) => point.v === points[0]?.v)) return String(points[0]?.v ?? 1);
  let expression = String(points.at(-1)?.v ?? 1);
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const a = points[index] as { t: number; v: number };
    const b = points[index + 1] as { t: number; v: number };
    const slope = b.t > a.t ? (b.v - a.v) / (b.t - a.t) : 0;
    expression = `if(lt(t,${b.t.toFixed(4)}),${a.v.toFixed(4)}+${slope.toFixed(6)}*(t-${a.t.toFixed(4)}),${expression})`;
  }
  return `'${expression}'`;
}

function tempo(rate: number): string[] {
  const stages: string[] = [];
  let rest = rate;
  while (rest > 2) {
    stages.push("atempo=2");
    rest /= 2;
  }
  while (rest < 0.5) {
    stages.push("atempo=0.5");
    rest /= 0.5;
  }
  if (Math.abs(rest - 1) > 1e-4) stages.push(`atempo=${rest.toFixed(6)}`);
  return stages;
}

export async function boardAudioMix(spans: readonly BoardMediaSpan[], files: BoardMediaFiles, firstInput: number): Promise<{ inputs: string[]; filter: string } | null> {
  const inputs: string[] = [];
  const chains: string[] = [];
  for (const span of spans) {
    if (!(await files.audible(span.src, span.kind))) continue;
    const index = firstInput + chains.length;
    inputs.push("-i", await files.path(span.src, span.kind));
    const length = ((span.end - span.start) * span.rate) / 1000;
    const delay = Math.max(0, Math.round(span.start));
    const filters = [
      `atrim=start=${(span.from / 1000).toFixed(4)}:duration=${length.toFixed(4)}`,
      "asetpts=PTS-STARTPTS",
      ...tempo(span.rate),
      `volume=${volumeExpression(span)}:eval=frame`,
      `adelay=${delay}:all=1`,
    ];
    chains.push(`[${index}:a]${filters.join(",")}[a${chains.length}]`);
  }
  if (!chains.length) return null;
  const mixed = chains.map((_, index) => `[a${index}]`).join("");
  return { inputs, filter: `${chains.join(";")};${mixed}amix=inputs=${chains.length}:duration=longest:dropout_transition=0:normalize=0[aout]` };
}
