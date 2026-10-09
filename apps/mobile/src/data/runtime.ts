import type { RuntimeStatus } from "@neta-art/cohub";
import type { ChatModelSelection } from "@/src/data/types";

export type RuntimeHarness = "cohub" | "pi" | "codex";
export type LocalRuntimeModel = ChatModelSelection & { name: string };
export type SpaceRuntimeStatus = RuntimeStatus;

export function canUseRuntimeHarness(status: SpaceRuntimeStatus | null, harness: RuntimeHarness): boolean {
  return harness === "cohub" || Boolean(status?.kind === "local" && status.online && status.capabilities?.harnesses.includes(harness));
}

export function localModelsForHarness(status: SpaceRuntimeStatus | null, harness: RuntimeHarness): LocalRuntimeModel[] {
  if (!status?.online || harness === "cohub") return [];
  return (status.capabilities?.models ?? [])
    .filter((model) => model.harness === harness)
    .map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
}

export function runtimeHarnessFromTurn(turn: { meta?: Record<string, unknown> | null; harness?: string | null } | null | undefined): RuntimeHarness {
  const harness = turn?.meta?.harness ?? turn?.harness;
  return harness === "pi" || harness === "codex" ? harness : "cohub";
}
