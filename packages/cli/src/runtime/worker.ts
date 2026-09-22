import { runRuntime, type RuntimeLaunch } from "./supervisor.js";
import { serializeDiagnosticError } from "./diagnostics.js";

const notify = (message: Record<string, unknown>) => {
  // The launcher deliberately disconnects after its one-shot summary.
  if (process.connected) process.send?.(message, () => undefined);
};

process.once("message", (config: RuntimeLaunch) => {
  void runRuntime(config, (status) => {
    notify({ type: "status", status });
  }, undefined, (event) => {
    notify({ type: "diagnostic", event });
  }).catch((error) => {
    notify({ type: "failed", error: serializeDiagnosticError(error).message });
    process.exitCode = 1;
  }).finally(() => {
    if (process.connected) process.disconnect?.();
  });
});
