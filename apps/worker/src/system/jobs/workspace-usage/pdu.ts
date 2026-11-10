import { spawn } from "node:child_process";

export const PDU_VERSION = "0.24.0";
export const pduBinary = () => process.env.WORKSPACE_USAGE_PDU_PATH || "pdu";

const MAX_STDOUT = 64 * 1024;
const MAX_STDERR = 16 * 1024;
// Entries deleted while pdu walks a live tree are expected; any other read error
// would silently undercount, so it fails the scan.
const VANISHED_ENTRY = /\(os error 2\)$/;

/** Splits stderr into lines as it streams so no error is lost to buffering limits. */
export function createStderrClassifier() {
  let partial = "";
  let fatal: string | null = null;
  const classify = (line: string) => {
    const trimmed = line.trim();
    if (trimmed && !VANISHED_ENTRY.test(trimmed)) fatal ??= trimmed.slice(0, 300);
  };
  return {
    push(chunk: string) {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      if (partial.length > MAX_STDERR) {
        classify(partial);
        partial = "";
      }
      lines.forEach(classify);
    },
    end() {
      classify(partial);
      partial = "";
      return fatal;
    },
  };
}

export function parsePduOutput(stdout: string, fatal: string | null, code: number | null) {
  if (code !== 0) throw new Error(`pdu exited with code ${code}${fatal ? `: ${fatal}` : ""}`);
  if (fatal) throw new Error(`pdu read error: ${fatal}`);
  const value = JSON.parse(stdout);
  const size = value?.tree?.size;
  if (value?.pdu !== PDU_VERSION || value?.unit !== "bytes" || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("unexpected pdu output");
  }
  return size as number;
}

const PDU_ARGS = [
  "--quantity=block-size", "--deduplicate-hardlinks", "--one-file-system", "--json-output",
  "--max-depth=1", "--no-sort", "--omit-json-shared-details", "--omit-json-shared-summary",
];

/**
 * pdu runs under coreutils `timeout`, so it dies at the deadline even if this
 * process is paused or gone. SIGTERM to `timeout` is forwarded to pdu.
 */
export function runPdu(input: { path: string; threads: number; deadline: number; binary?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const remainingMs = input.deadline - Date.now();
    if (remainingMs < 1000) return reject(new Error("workspace scan deadline passed"));
    let stdout = "";
    const stderr = createStderrClassifier();
    let failure: Error | null = null;
    const child = spawn("timeout", [
      "--signal=KILL", `${Math.floor(remainingMs / 1000)}s`,
      input.binary ?? pduBinary(), `--threads=${input.threads}`, ...PDU_ARGS, "--", input.path,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stop = (message: string) => {
      failure ??= new Error(message);
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => stop("pdu timed out"), remainingMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_STDOUT) stop("pdu output too large");
      else stdout += chunk.toString("utf8");
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      // `timeout` re-raises the KILL it sent, or exits 124/137.
      if (signal === "SIGKILL" || code === 124 || code === 137) return reject(new Error("pdu timed out"));
      try { resolve(parsePduOutput(stdout, stderr.end(), code)); } catch (error) { reject(error); }
    });
  });
}

function probe(command: string, args: string[], expect: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0 && out.includes(expect)));
  });
}

export async function isPduAvailable(binary = pduBinary()) {
  const [pdu, timeout] = await Promise.all([probe(binary, ["--version"], PDU_VERSION), probe("timeout", ["--version"], "timeout")]);
  return pdu && timeout;
}
