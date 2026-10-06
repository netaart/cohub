import { z } from "zod";

/**
 * Contract between a Cohub web surface and the native host embedding it.
 * Mirrored in Kotlin by `apps/android/.../host/HostProtocol.kt`.
 *
 * Capabilities gate calls, not versions: a newer host is fine, a missing
 * capability is not. Adding one is safe; removing one breaks shipped bundles.
 */

export const HOST_BRIDGE_VERSION = 1 as const;
export const HOST_BRIDGE_GLOBAL = "cohubHost" as const;

export const HOST_BRIDGE_CAPABILITIES = [
  "auth.token",
  "auth.signIn",
  "auth.session",
  "notifications",
  "share",
  "filePicker",
  "navigation",
  "cache",
  "runtime",
  "appearance",
] as const;
export type HostBridgeCapability = (typeof HOST_BRIDGE_CAPABILITIES)[number];
export const hostBridgeCapabilitySchema = z.enum(HOST_BRIDGE_CAPABILITIES);

export const hostPlatformSchema = z.enum(["android", "ios", "web", "unknown"]);
export type HostPlatform = z.infer<typeof hostPlatformSchema>;

const identifier = z.string().min(1).max(128);

/** Pushed by hosts that predate the `host.describe` handshake. */
export const hostBridgeHelloSchema = z.object({
  type: z.literal("hello"),
  version: z.number().int().positive(),
  platform: hostPlatformSchema,
  hostId: identifier,
  capabilities: z.array(hostBridgeCapabilitySchema).max(HOST_BRIDGE_CAPABILITIES.length),
}).strict();
export type HostBridgeHello = z.infer<typeof hostBridgeHelloSchema>;

export const hostDescriptionSchema = hostBridgeHelloSchema.omit({ type: true });
export type HostDescription = z.infer<typeof hostDescriptionSchema>;

export const hostBridgeRequestSchema = z.object({
  type: z.literal("request"),
  id: identifier,
  method: z.string().min(1).max(64),
  params: z.unknown().optional(),
}).strict();
export type HostBridgeRequest = z.infer<typeof hostBridgeRequestSchema>;

export const hostBridgeResponseSchema = z.object({
  type: z.literal("response"),
  id: identifier,
  result: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(2_000),
  }).strict().optional(),
}).strict();
export type HostBridgeResponse = z.infer<typeof hostBridgeResponseSchema>;

export const hostBridgeEventSchema = z.object({
  type: z.literal("event"),
  name: z.string().min(1).max(64),
  payload: z.unknown().optional(),
}).strict();
export type HostBridgeEvent = z.infer<typeof hostBridgeEventSchema>;

export const hostBridgeMessageSchema = z.discriminatedUnion("type", [
  hostBridgeHelloSchema,
  hostBridgeRequestSchema,
  hostBridgeResponseSchema,
  hostBridgeEventSchema,
]);
export type HostBridgeMessage = z.infer<typeof hostBridgeMessageSchema>;

const accessTokenParams = z.object({ forceRefresh: z.boolean().optional() }).strict();
const sessionIdentitySchema = z.object({
  authenticated: z.boolean(),
  userUuid: z.string().min(1).max(128).nullable(),
  subject: z.string().min(1).max(255).nullable(),
  email: z.string().max(320).nullable(),
}).strict();

export const DEVICE_RUNTIME_ERRORS = ["signed_out", "forbidden", "conflict"] as const;
export const DEVICE_RUNTIME_REFUSALS = ["space_in_use", "folder_in_use", "folder_unavailable"] as const;

const devicePath = z.string().min(1).max(4_096);
const deviceLabel = z.string().min(1).max(4_096);

export const deviceRuntimeInstanceSchema = z.object({
  spaceId: z.uuid(),
  root: devicePath,
  label: deviceLabel,
  state: z.enum(["stopped", "connecting", "ready", "error"]),
  error: z.string().min(1).max(64).nullable(),
}).strict();
export type DeviceRuntimeInstance = z.infer<typeof deviceRuntimeInstanceSchema>;

export const deviceRuntimeSchema = z.object({
  instances: z.array(deviceRuntimeInstanceSchema).max(256),
}).strict();
export type DeviceRuntime = z.infer<typeof deviceRuntimeSchema>;

export const deviceFolderListingSchema = z.object({
  path: devicePath,
  label: deviceLabel,
  parent: devicePath.nullable(),
  spaceId: z.uuid().nullable(),
  folders: z.array(z.object({ name: z.string().min(1).max(255), path: devicePath }).strict()).max(10_000),
  volumes: z.array(z.object({ path: devicePath, label: deviceLabel }).strict()).max(16),
}).strict();
export type DeviceFolderListing = z.infer<typeof deviceFolderListingSchema>;

export const hostColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

/**
 * Methods the web surface may call. Both ends validate with these schemas, so
 * a host cannot answer a shape the web side misreads.
 */
export const HOST_BRIDGE_METHODS = {
  "host.describe": { params: z.undefined(), result: hostDescriptionSchema },
  "auth.getAccessToken": { params: accessTokenParams, result: z.string().min(1).nullable() },
  "auth.getSessionVersion": { params: z.undefined(), result: z.number().int().nonnegative() },
  /** ID token claims never cross the bridge; this is the only identity source. */
  "auth.getSession": { params: z.undefined(), result: sessionIdentitySchema },
  "auth.signIn": { params: z.object({ redirectPath: z.string().max(2_048).optional() }).strict(), result: z.boolean() },
  "auth.signOut": { params: z.undefined(), result: z.boolean() },
  "notifications.register": { params: z.undefined(), result: z.boolean() },
  "share.text": { params: z.object({ text: z.string().max(100_000), title: z.string().max(512).optional() }).strict(), result: z.boolean() },
  "navigation.openPath": { params: z.object({ path: z.string().min(1).max(2_048) }).strict(), result: z.boolean() },
  "cache.clear": { params: z.object({ scope: z.enum(["all", "user"]) }).strict(), result: z.boolean() },
  "runtime.list": { params: z.undefined(), result: deviceRuntimeSchema },
  "runtime.browse": { params: z.object({ path: devicePath.optional() }).strict(), result: deviceFolderListingSchema },
  "runtime.start": {
    params: z.object({ spaceId: z.uuid(), root: devicePath }).strict(),
    result: deviceRuntimeSchema.extend({ refused: z.enum(DEVICE_RUNTIME_REFUSALS).nullable() }).strict(),
  },
  "runtime.stop": { params: z.object({ spaceId: z.uuid() }).strict(), result: deviceRuntimeSchema },
  "appearance.set": { params: z.object({ backgroundColor: hostColorSchema }).strict(), result: z.boolean() },
} as const;
export type HostBridgeMethod = keyof typeof HOST_BRIDGE_METHODS;

export const HOST_BRIDGE_EVENTS = ["auth.changed", "auth.signedOut", "navigation.back", "app.foreground", "app.background", "runtime.changed"] as const;
export type HostBridgeEventName = (typeof HOST_BRIDGE_EVENTS)[number];

export const HOST_BRIDGE_ERROR = {
  unsupported: "unsupported",
  unauthorized: "unauthorized",
  canceled: "canceled",
  failed: "failed",
} as const;
export type HostBridgeErrorCode = (typeof HOST_BRIDGE_ERROR)[keyof typeof HOST_BRIDGE_ERROR];

export const HOST_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
export const HOST_BRIDGE_INTERACTIVE_TIMEOUT_MS = 5 * 60_000;
/** Short on purpose: a missing host must not delay the first screen. */
export const HOST_BRIDGE_HANDSHAKE_TIMEOUT_MS = 2_000;
