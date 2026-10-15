import { z } from "zod";

export const localHarnessSchema = z.enum(["pi", "codex", "workbuddy"]);
export type LocalHarness = z.infer<typeof localHarnessSchema>;
export const harnessSchema = z.enum(["cohub", ...localHarnessSchema.options]);
export type HarnessKind = z.infer<typeof harnessSchema>;
export const isLocalHarness = (value: unknown): value is LocalHarness => localHarnessSchema.safeParse(value).success;
export const resolveHarness = (meta: unknown): HarnessKind => {
  const value = meta && typeof meta === "object" ? (meta as { harness?: unknown }).harness : null;
  return isLocalHarness(value) ? value : "cohub";
};
