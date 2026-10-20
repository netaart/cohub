import { z } from "zod";

/** Single source of truth for local Harness identities. Adding a Harness starts here. */
export const LOCAL_HARNESSES = ["pi", "codex", "claude", "workbuddy", "cursor"] as const;
export type LocalHarness = typeof LOCAL_HARNESSES[number];

export type LocalHarnessSpec = {
  label: string;
  /** Archive format tag; immutable once archives exist. */
  nativeFormat: string;
  /** Whether the Harness can enforce read-only execution. */
  readOnly: boolean;
};

export const LOCAL_HARNESS_SPECS: Readonly<Record<LocalHarness, LocalHarnessSpec>> = {
  pi: { label: "Pi", nativeFormat: "pi.jsonl", readOnly: false },
  codex: { label: "Codex", nativeFormat: "codex.rollout", readOnly: true },
  claude: { label: "Claude Code", nativeFormat: "claude.jsonl", readOnly: true },
  workbuddy: { label: "WorkBuddy", nativeFormat: "codebuddy.jsonl", readOnly: true },
  cursor: { label: "Cursor", nativeFormat: "cursor.jsonl", readOnly: false },
};

export const localHarnessSchema = z.enum(LOCAL_HARNESSES);
export const harnessSchema = z.enum(["cohub", ...LOCAL_HARNESSES]);
export type HarnessKind = z.infer<typeof harnessSchema>;

export const isLocalHarness = (value: unknown): value is LocalHarness => (LOCAL_HARNESSES as readonly unknown[]).includes(value);
export const resolveHarness = (meta: unknown): HarnessKind => {
  const value = meta && typeof meta === "object" ? (meta as { harness?: unknown }).harness : null;
  return isLocalHarness(value) ? value : "cohub";
};
export const harnessLabel = (harness: HarnessKind): string => harness === "cohub" ? "Cohub" : LOCAL_HARNESS_SPECS[harness].label;
export const assertHarnessAccess = (harness: unknown, accessMode: string | null | undefined) => {
  if (accessMode === "read_only" && isLocalHarness(harness) && !LOCAL_HARNESS_SPECS[harness].readOnly) {
    throw new Error(`${LOCAL_HARNESS_SPECS[harness].label} cannot enforce read-only access`);
  }
};
