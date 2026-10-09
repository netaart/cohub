import type { SandboxCapabilities } from "@cohub/protocol/sandbox";

type ExecutableCapabilities = Pick<SandboxCapabilities, "processStartArgv" | "processFd" | "processRg">;

export function runsExecutableDirectly(capabilities: ExecutableCapabilities | undefined, executable: "processFd" | "processRg") {
  return capabilities?.processStartArgv === true && capabilities[executable] !== false;
}
