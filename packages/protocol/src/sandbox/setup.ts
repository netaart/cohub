import * as z from "zod";

export type SandboxBootstrapGate = { status: "waiting" | "ready" | "failed" };

const output = z.string().max(8192);
const result = {
  exitCode: z.number().int(),
  stdout: output,
  stderr: output,
  duration: z.string().max(64),
  error: z.string().max(4096).optional(),
};

export const sandboxSetupStepSchema = z.object({
  ...result,
  path: z.string().max(4096),
  status: z.enum(["running", "succeeded", "failed"]),
  logDir: z.string().max(4096),
});

export const sandboxSetupInfoSchema = z.object({
  ...result,
  ran: z.boolean(),
  status: z.enum(["waiting", "running", "succeeded", "failed"]).optional(),
  steps: z.array(sandboxSetupStepSchema).max(128).optional(),
  runId: z.uuid().optional(),
});

export type SandboxSetupStep = z.infer<typeof sandboxSetupStepSchema>;
export type SandboxSetupInfo = z.infer<typeof sandboxSetupInfoSchema>;
