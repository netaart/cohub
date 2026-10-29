import { spawn } from "node:child_process";

export const PDU_VERSION = "0.24.0";
export const pduBinary = () => process.env.WORKSPACE_USAGE_PDU_PATH || "pdu";

const MAX_STDOUT = 64 * 1024;
const MAX_STDERR = 16 * 1024;
// Entries deleted while pdu walks a live tree are expected; any other read error
// would silently undercount, so it fails the scan.
const VANISHED_ENTRY = /\(os error 2\)$/;

export function parsePduOutput(stdout: string, stderr: string, code: number | null) {
  if (code !== 0) throw new Error(`pdu exited with code ${code}: ${firstLine(stderr)}`);
  const fatal = stderr.split("\n").map((line) => line.trim()).filter((line) => line && !VANISHED_ENTRY.test(line));
  if (fatal.length) throw new Error(`pdu read error: ${fatal[0]}`);
  const value = JSON.parse(stdout);
  const size = value?.tree?.size;
  if (value?.pdu !== PDU_VERSION || value?.unit !== "bytes" || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("unexpected pdu output");
  }
  return size as number;
}

function firstLine(text: string) {
  return text.trim().split("\n")[0]?.slice(0, 300) ?? "";
}

export function runPdu(input: { path: string; threads: number; timeoutMs: number; binary?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let failure: Error | null = null;
    const child = spawn(input.binary ?? pduBinary(), [
      `--threads=${input.threads}`, "--quantity=block-size", "--deduplicate-hardlinks", "--one-file-system",
      "--json-output", "--max-depth=1", "--no-sort", "--omit-json-shared-details", "--omit-json-shared-summary",
      "--", input.path,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stop = (message: string) => {
      failure ??= new Error(message);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(`pdu timed out after ${Math.round(input.timeoutMs / 1000)}s`), input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_STDOUT) stop("pdu output too large");
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      try { resolve(parsePduOutput(stdout, stderr, code)); } catch (error) { reject(error); }
    });
  });
}

export function isPduAvailable(binary = pduBinary()): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0 && out.includes(PDU_VERSION)));
  });
}
