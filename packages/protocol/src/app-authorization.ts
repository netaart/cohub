import { z } from "zod";

export const appAuthorizationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account") }),
  z.object({ kind: z.literal("space"), spaceId: z.string().min(1) }),
  z.object({ kind: z.literal("pick-space") }),
]);

/**
 * Read-only scopes the Shell may renew without a dialog for any App on the
 * Space it shows. The API still checks the viewer's own permissions.
 */
export const APP_SILENT_SHELL_SCOPES = [
  "space.view",
  "file.view",
  "file.view.filtered",
  "session.view",
  "taskrun.view",
  "checkpoint.view",
] as const;

const APP_SILENT_SHELL_SCOPE_SET = new Set<string>(APP_SILENT_SHELL_SCOPES);

export const isAppSilentShellScope = (scope: string): boolean =>
  APP_SILENT_SHELL_SCOPE_SET.has(scope);

/**
 * The API-enforced ceiling for Host consent (`consent: "host"`), given to Apps
 * the Shell Space published or installed. Trust is decided by the Shell, the
 * only holder of the viewer's token.
 */
export const APP_HOST_CONSENT_SCOPES = [...APP_SILENT_SHELL_SCOPES, "file.edit"] as const;

const APP_HOST_CONSENT_SCOPE_SET = new Set<string>(APP_HOST_CONSENT_SCOPES);

export const isAppHostConsentScope = (scope: string): boolean =>
  APP_HOST_CONSENT_SCOPE_SET.has(scope);

export const appAuthorizationRequestSchema = z.object({
  target: appAuthorizationTargetSchema,
  scopes: z.array(z.string().min(1)).min(1).max(128),
  reason: z.string().max(280).optional(),
  alwaysAsk: z.boolean().optional(),
  fallback: z.enum(["allow", "none"]).default("allow"),
});

export const appAuthorizationGrantSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
});

export const appAuthorizationResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("granted"),
    requestedTarget: appAuthorizationTargetSchema,
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("account") }),
      z.object({ kind: z.literal("space"), spaceId: z.string().min(1), name: z.string().nullable() }),
    ]),
    resolution: z.enum(["requested", "selected", "fallback"]),
    grant: appAuthorizationGrantSchema,
  }),
  z.object({ status: z.literal("cancelled") }),
  z.object({ status: z.literal("denied"), code: z.string() }),
]);

export type AppAuthorizationTarget = z.infer<typeof appAuthorizationTargetSchema>;
export type AppAuthorizationGrant = z.infer<typeof appAuthorizationGrantSchema>;
export type AppAuthorizationResult = z.infer<typeof appAuthorizationResultSchema>;
export type AppAuthorizationRequest = z.input<typeof appAuthorizationRequestSchema>;
