import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeArchiveStore, type ArchiveTransport } from "../../src/runtime/archive-store.js";
import { RuntimeDiagnostics } from "../../src/runtime/diagnostics.js";
import type { NativeConfig } from "../../src/runtime/native/config.js";
import { NativeRuntime } from "../../src/runtime/native/daemon.js";
import type { SessionTurnProjectionClient } from "../../src/runtime/turn-projection.js";
import { runtimeProjectionSource, type RuntimeProjectionSourceFixture } from "./runtime-projection-source.js";

export type TestNativeRuntime = {
  native: NativeRuntime;
  source: RuntimeProjectionSourceFixture;
  archives: RuntimeArchiveStore;
  stateRoot: string;
  close(): Promise<void>;
};

/**
 * A Runtime's native side on isolated state: executor, results, ingest and the Pi control socket.
 * Harness executables are the fixtures in this directory unless a test names others.
 */
export async function testNativeRuntime(options: {
  spaceId: string;
  root: string;
  stateRoot?: string;
  harnesses?: Array<"pi" | "codex">;
  executables?: { pi?: string; codex?: string };
  transport?: ArchiveTransport;
  /** Durable Turns the Runtime projects from; an in-memory fixture unless a test brings its own. */
  projectionSource?: SessionTurnProjectionClient;
  config?: NativeConfig | null;
}): Promise<TestNativeRuntime> {
  // The Pi extension finds the Runtime through this directory; keep every test's socket apart.
  process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "cohub-xdg-"));
  const stateRoot = options.stateRoot ?? join(options.root, "state");
  const source = runtimeProjectionSource();
  const archives = new RuntimeArchiveStore(join(stateRoot, "archives"), options.transport ?? null);
  const diagnostics = new RuntimeDiagnostics({ root: stateRoot, spaceId: options.spaceId });
  const harnesses = options.harnesses ?? ["pi", "codex"];
  const native = new NativeRuntime({
    spaceId: options.spaceId, root: options.root, stateRoot, harnesses,
    executables: { pi: options.executables?.pi ?? fixture("pi"), codex: options.executables?.codex ?? fixture("codex") },
    identity: "test", config: options.config ?? null, archives, projectionSource: options.projectionSource ?? source, diagnostics,
  });
  const controller = new AbortController();
  await native.start(controller.signal);
  const xdg = process.env.XDG_STATE_HOME;
  return {
    native, source, archives, stateRoot,
    close: async () => {
      controller.abort();
      await native.close(AbortSignal.timeout(2_000));
      await diagnostics.close();
      await rm(xdg, { recursive: true, force: true });
    },
  };
}

export const fixture = (harness: "pi" | "codex") => new URL(`./runtime-${harness}.mjs`, import.meta.url).pathname;

/** An executor that is never asked to run a Turn: for tests of the connection alone. */
export function idleExecutor(spaceId: string, root = join(tmpdir(), `cohub-idle-${spaceId}`)) {
  const stateRoot = join(root, "state");
  return new NativeRuntime({
    spaceId, root, stateRoot, harnesses: ["pi"], executables: {}, identity: "test", config: null,
    archives: new RuntimeArchiveStore(join(stateRoot, "archives"), null), projectionSource: runtimeProjectionSource(),
    diagnostics: new RuntimeDiagnostics({ root: stateRoot, spaceId }),
  }).executor;
}
