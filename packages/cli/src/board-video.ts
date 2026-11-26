import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Writable } from "node:stream";
import type { BoardMediaSpan } from "@neta-art/cohub/board";
import { type BoardMediaFiles, boardAudioMix } from "./board-media-export.js";

export type BoardVideoFormat = "mp4" | "webm";

const CODEC: Record<BoardVideoFormat, { video: string[]; audio: string[]; container: string[] }> = {
  mp4: { video: ["-c:v", "libx264", "-pix_fmt", "yuv420p"], audio: ["-c:a", "aac"], container: ["-movflags", "+faststart", "-f", "mp4"] },
  webm: { video: ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1"], audio: ["-c:a", "libopus"], container: ["-f", "webm"] },
};

export async function checkFfmpeg(signal?: AbortSignal): Promise<void> {
  await ffmpeg(["-version"], signal).done;
}

function ffmpeg(args: string[], signal?: AbortSignal): { stdin: Writable | null; done: Promise<void>; kill(): void } {
  const child = spawn("ffmpeg", ["-v", "error", "-y", ...args], { stdio: [args.includes("-") ? "pipe" : "ignore", "ignore", "pipe"], signal });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.stdin?.on("error", () => {});
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? new Error("Video export needs ffmpeg. Install ffmpeg and try again.") : error));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg could not encode the video: ${stderr.trim().split("\n").slice(-6).join("\n") || `exit ${code}`}`)));
  });
  done.catch(() => {});
  return { stdin: child.stdin, done, kill: () => child.kill("SIGKILL") };
}

export function createBoardVideoEncoder(options: { format: BoardVideoFormat; fps: number; path: string; signal?: AbortSignal }) {
  let encoder: ReturnType<typeof ffmpeg> | null = null;
  let size: { width: number; height: number } | null = null;
  let count = 0;
  return {
    get frames() {
      return count;
    },
    get size() {
      return size;
    },
    async write(bytes: Uint8Array, width: number, height: number): Promise<void> {
      if (size && (size.width !== width || size.height !== height)) throw new Error("Video frame dimensions changed. Use a fixed export region or a smaller camera viewport.");
      if (bytes.byteLength !== width * height * 4) throw new Error("A video frame is not raw RGBA.");
      if (!encoder) {
        size = { width, height };
        const pad = options.format === "mp4" && (width % 2 || height % 2) ? ["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"] : [];
        encoder = ffmpeg([
          "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", String(options.fps), "-i", "-",
          ...pad, ...CODEC[options.format].video, "-an", ...CODEC[options.format].container, options.path,
        ], options.signal);
      }
      const { stdin, done } = encoder;
      count++;
      if (stdin && !stdin.write(bytes)) await Promise.race([once(stdin, "drain"), done.then(() => { throw new Error("ffmpeg stopped reading frames."); })]);
    },
    async finish(): Promise<void> {
      if (!encoder) return;
      encoder.stdin?.end();
      await encoder.done;
    },
    async abort(): Promise<void> {
      if (!encoder) return;
      encoder.kill();
      await encoder.done.catch(() => {});
    },
  };
}

export async function muxBoardVideo(options: {
  format: BoardVideoFormat;
  video: string;
  output: string;
  spans: readonly BoardMediaSpan[];
  files: BoardMediaFiles;
  duration: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  const mix = await boardAudioMix(options.spans, options.files, 1);
  if (!mix) return false;
  await ffmpeg([
    "-i", options.video, ...mix.inputs, "-filter_complex", mix.filter, "-map", "0:v:0", "-map", "[aout]",
    "-c:v", "copy", ...CODEC[options.format].audio, ...CODEC[options.format].container, "-t", options.duration.toFixed(3), options.output,
  ], options.signal).done;
  return true;
}
