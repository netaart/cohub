import { enableEnvProxy } from "../env-proxy.js";
import { runRuntime, type RuntimeLaunch } from "./supervisor.js";
import { serializeDiagnosticError } from "./diagnostics.js";
import { successorServes } from "./detached.js";
import { runtimeInstanceDirectory } from "./instance.js";
import type { RuntimeSummary } from "./presentation.js";

enableEnvProxy();

const notify = (message: Record<string, unknown>) => {
  // The launcher deliberately disconnects after its one-shot summary.
  if (process.connected) process.send?.(message, () => undefined);
};

process.once("message", (config: RuntimeLaunch) => {
  void (async () => {
    let launch = config;
    for (;;) {
      let runtimeId = "";
      const handedTo = await runRuntime(launch, (status: RuntimeSummary) => {
        runtimeId = status.runtimeId;
        notify({ type: "status", status });
      }, undefined, (event) => {
        notify({ type: "diagnostic", event });
      });
      if (!handedTo || await successorServes(runtimeInstanceDirectory(config.identity, config.spaceId), runtimeId)) return;
      launch = { ...config, resume: { runtimeId }, skipUpdate: handedTo, importHistory: false, display: undefined };
    }
  })().catch((error) => {
    notify({ type: "failed", error: serializeDiagnosticError(error).message });
    process.exitCode = 1;
  }).finally(() => {
    if (process.connected) process.disconnect?.();
  });
});
