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
  "launch",
  "haptics",
  "files",
  "navigation.back",
  "shortcuts",
  "display",
  "media.capture",
  "runtime.picker",
  "permissions",
  "badge",
  "app.launchAtLogin",
  "app.globalShortcut",
  "runtime.keepAwake",
  "share.incoming",
  "workspace",
  "workspace.files",
] as const;
export type HostBridgeCapability = (typeof HOST_BRIDGE_CAPABILITIES)[number];
export const hostBridgeCapabilitySchema = z.enum(HOST_BRIDGE_CAPABILITIES);

export const hostPlatformSchema = z.enum(["android", "ios", "macos", "windows", "web", "unknown"]);
export type HostPlatform = z.infer<typeof hostPlatformSchema>;

const identifier = z.string().min(1).max(128);

/** Unknown capabilities from a newer host are dropped, not rejected. */
const knownCapabilitiesSchema = z
  .array(z.string().min(1).max(64))
  .max(64)
  .transform((names) =>
    names.filter((name): name is HostBridgeCapability => hostBridgeCapabilitySchema.safeParse(name).success),
  );

/** Pushed by hosts that predate the `host.describe` handshake. */
export const hostBridgeHelloSchema = z.object({
  type: z.literal("hello"),
  version: z.number().int().positive(),
  platform: hostPlatformSchema,
  hostId: identifier,
  capabilities: knownCapabilitiesSchema,
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

export const DEVICE_RUNTIME_ERRORS = ["signed_out", "forbidden", "conflict", "elevated", "offline", "folder_denied", "no_shell", "storage_denied"] as const;
export const DEVICE_RUNTIME_REFUSALS = ["space_in_use", "folder_in_use", "folder_unavailable", "folder_denied"] as const;
export const DEVICE_RUNTIME_STOP_REFUSALS = ["unconfirmed_work"] as const;

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

export const deviceDisplayStatusSchema = z.object({
  sharedWith: z.uuid().nullable(),
  control: z.boolean(),
  error: z.string().min(1).max(64).nullable(),
}).strict();
export type DeviceDisplayStatus = z.infer<typeof deviceDisplayStatusSchema>;

export const HOST_PERMISSIONS = ["files", "microphone", "camera", "notifications", "background", "screen", "control"] as const;
export type HostPermission = (typeof HOST_PERMISSIONS)[number];
export const hostPermissionSchema = z.enum(HOST_PERMISSIONS);

export const HOST_PERMISSION_STATES = ["granted", "denied", "prompt"] as const;
export type HostPermissionState = (typeof HOST_PERMISSION_STATES)[number];
const hostPermissionStateSchema = z.enum(HOST_PERMISSION_STATES);

export const hostPermissionsSchema = z.object({
  files: hostPermissionStateSchema.optional(),
  microphone: hostPermissionStateSchema.optional(),
  camera: hostPermissionStateSchema.optional(),
  notifications: hostPermissionStateSchema.optional(),
  background: hostPermissionStateSchema.optional(),
});
export type HostPermissions = z.infer<typeof hostPermissionsSchema>;

export const HOST_SHARE_FILE_MAX_BYTES = 12 * 1024 * 1024;

export const hostIncomingShareSchema = z.object({
  id: identifier,
  text: z.string().max(100_000).nullable(),
  files: z.array(z.object({
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
  }).strict()).max(16),
}).strict();
export type HostIncomingShare = z.infer<typeof hostIncomingShareSchema>;

export const hostColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

export const HOST_HAPTICS = ["tick", "confirm", "reject", "longPress"] as const;
export type HostHaptic = (typeof HOST_HAPTICS)[number];

/** Hosts parse messages on their UI thread; larger files go by URL. */
export const HOST_FILE_DATA_MAX_LENGTH = 16 * 1024 * 1024;

const savedFileSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255).optional(),
});

export const hostFileSaveParamsSchema = z.union([
  savedFileSchema.extend({ url: z.url({ protocol: /^https$/ }).max(8_192) }).strict(),
  savedFileSchema.extend({ data: z.base64().max(HOST_FILE_DATA_MAX_LENGTH) }).strict(),
]);
export type HostFileSaveParams = z.infer<typeof hostFileSaveParamsSchema>;

const settingParams = z.object({ enabled: z.boolean().optional() }).strict();

const inAppPath = z.string().regex(/^\/(?!\/)/, "an in-app path").max(2_048);

export const hostShortcutSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(64),
  path: inAppPath,
}).strict();
export type HostShortcut = z.infer<typeof hostShortcutSchema>;

export const hostNotificationSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  body: z.string().max(2_000).optional(),
  path: inAppPath,
}).strict();
export type HostNotification = z.infer<typeof hostNotificationSchema>;

export const hostAuthChangedSchema = z.object({
  authenticated: z.boolean(),
  redirectPath: inAppPath.optional(),
}).strict();
export type HostAuthChanged = z.infer<typeof hostAuthChangedSchema>;

/**
 * This device's Runtime answers a Space's filesystem calls directly when it
 * serves that Space. Only `fs.*` crosses the bridge: process work stays on the
 * Cohub pipeline. A request larger than this stays on the API: hosts read the
 * bridge line by line.
 */
export const HOST_WORKSPACE_METHOD_PATTERN = /^fs\.[a-z]+$/;
export const HOST_WORKSPACE_CALL_MAX_BYTES = 768 * 1024;

const workspaceCallResultSchema = z.union([
  z.object({ result: z.unknown() }).strict(),
  z.object({ error: z.object({ code: z.string().min(1).max(64), message: z.string().max(4_000) }).strict() }).strict(),
]);
export type HostWorkspaceCallResult = z.infer<typeof workspaceCallResultSchema>;

/**
 * Where a host with `workspace.files` streams a Space's files, with ranges.
 * WebKit cannot intercept https, so WebKit hosts answer a custom scheme;
 * others intercept a same-origin path the server never serves.
 */
export const HOST_WORKSPACE_SCHEME = "cohub-workspace";
export const HOST_WORKSPACE_PATH = "/__cohub/workspace/";

export function hostWorkspaceFileUrl(input: { platform: HostPlatform; origin: string; spaceId: string; path: string; version?: string }) {
  const query = `files?${new URLSearchParams({ path: input.path, ...(input.version ? { v: input.version } : {}) })}`;
  return input.platform === "macos" || input.platform === "ios"
    ? `${HOST_WORKSPACE_SCHEME}://${input.spaceId}/${query}`
    : `${input.origin}${HOST_WORKSPACE_PATH}${input.spaceId}/${query}`;
}

/** Asked by a desktop shell to proxy file URLs; never forwarded from the page. */
export const HOST_SERVICE_WORKSPACE_ENDPOINT = "workspace.endpoint";

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
  "notifications.show": { params: hostNotificationSchema, result: z.boolean() },
  "share.text": { params: z.object({ text: z.string().max(100_000), title: z.string().max(512).optional() }).strict(), result: z.boolean() },
  "navigation.openPath": { params: z.object({ path: z.string().min(1).max(2_048) }).strict(), result: z.boolean() },
  "cache.clear": { params: z.object({ scope: z.enum(["all", "user"]) }).strict(), result: z.boolean() },
  "runtime.list": { params: z.undefined(), result: deviceRuntimeSchema },
  "runtime.browse": { params: z.object({ path: devicePath.optional() }).strict(), result: deviceFolderListingSchema },
  "runtime.start": {
    params: z.object({ spaceId: z.uuid(), root: devicePath }).strict(),
    result: deviceRuntimeSchema.extend({ refused: z.enum(DEVICE_RUNTIME_REFUSALS).nullable() }).strict(),
  },
  "runtime.stop": {
    params: z.object({ spaceId: z.uuid(), force: z.boolean().optional() }).strict(),
    result: deviceRuntimeSchema.extend({ refused: z.enum(DEVICE_RUNTIME_STOP_REFUSALS).nullable().optional() }).strict(),
  },
  "runtime.pickFolder": { params: z.object({ path: devicePath }).strict().optional(), result: deviceFolderListingSchema },
  "runtime.keepAwake": { params: settingParams, result: z.boolean() },
  "permissions.status": { params: z.undefined(), result: hostPermissionsSchema },
  "permissions.request": { params: z.object({ kind: hostPermissionSchema }).strict(), result: hostPermissionStateSchema },
  "permissions.openSettings": { params: z.object({ kind: hostPermissionSchema }).strict(), result: z.boolean() },
  "badge.set": { params: z.object({ count: z.number().int().nonnegative() }).strict(), result: z.boolean() },
  "app.launchAtLogin": { params: settingParams, result: z.boolean() },
  "app.globalShortcut": { params: settingParams, result: z.boolean() },
  "share.take": { params: z.undefined(), result: hostIncomingShareSchema.nullable() },
  "share.readFile": {
    params: z.object({ id: identifier, index: z.number().int().nonnegative() }).strict(),
    result: z.object({ data: z.base64().max(HOST_FILE_DATA_MAX_LENGTH) }).strict(),
  },
  "appearance.set": { params: z.object({ backgroundColor: hostColorSchema }).strict(), result: z.boolean() },
  "app.ready": { params: z.undefined(), result: z.boolean() },
  "haptics.perform": { params: z.object({ kind: z.enum(HOST_HAPTICS) }).strict(), result: z.boolean() },
  "files.save": { params: hostFileSaveParamsSchema, result: z.boolean() },
  "navigation.interceptBack": { params: z.object({ enabled: z.boolean() }).strict(), result: z.boolean() },
  "shortcuts.push": { params: hostShortcutSchema, result: z.boolean() },
  "display.status": { params: z.undefined(), result: deviceDisplayStatusSchema },
  "display.share": { params: z.object({ spaceId: z.uuid() }).strict(), result: deviceDisplayStatusSchema },
  "display.stop": { params: z.undefined(), result: deviceDisplayStatusSchema },
  "display.openControlSettings": { params: z.undefined(), result: z.boolean() },
  "workspace.call": {
    params: z.object({
      spaceId: z.uuid(),
      method: z.string().regex(HOST_WORKSPACE_METHOD_PATTERN).max(64),
      params: z.record(z.string(), z.unknown()).optional(),
    }).strict(),
    result: workspaceCallResultSchema,
  },
} as const;
export type HostBridgeMethod = keyof typeof HOST_BRIDGE_METHODS;

export const HOST_BRIDGE_EVENTS = ["auth.changed", "auth.signedOut", "navigation.back", "app.foreground", "app.background", "runtime.changed", "display.changed"] as const;
export type HostBridgeEventName = (typeof HOST_BRIDGE_EVENTS)[number];

export const HOST_BRIDGE_ERROR = {
  unsupported: "unsupported",
  unauthorized: "unauthorized",
  canceled: "canceled",
  failed: "failed",
  denied: "denied",
  unavailable: "unavailable",
} as const;
export type HostBridgeErrorCode = (typeof HOST_BRIDGE_ERROR)[keyof typeof HOST_BRIDGE_ERROR];

export const HOST_SERVICE_VERSION = 1 as const;

export const hostServiceHelloSchema = z.object({
  type: z.literal("hello"),
  version: z.number().int().positive(),
  capabilities: knownCapabilitiesSchema,
  methods: z.array(z.string().min(1).max(64)).max(64),
}).strict();
export type HostServiceHello = z.infer<typeof hostServiceHelloSchema>;

export const HOST_SERVICE_SHELL_EVENTS = {
  open: "shell.open",
} as const;

export const hostShellOpenSchema = z.object({ url: z.url({ protocol: /^https?$/ }).max(8_192) }).strict();

export const HOST_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
export const HOST_BRIDGE_INTERACTIVE_TIMEOUT_MS = 5 * 60_000;
/** Short on purpose: a missing host must not delay the first screen. */
export const HOST_BRIDGE_HANDSHAKE_TIMEOUT_MS = 2_000;
