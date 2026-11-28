import * as z from "zod";
import { APP_RUNTIME_HAPTICS, type AppRuntimeHaptic } from "./app-runtime.js";
import { displayIdSchema } from "./display/schema.js";

/**
 * Contract between a Cohub web surface and the native host embedding it.
 * Mirrored in Kotlin by `apps/android/.../host/HostProtocol.kt`.
 *
 * Capabilities gate calls, not versions: a newer host is fine, a missing
 * capability is not. Adding one is safe; removing one breaks shipped bundles.
 *
 * Web bundles deploy continuously while hosts update slowly, so every schema
 * accepts what it can: unknown fields are dropped, never rejected. Limits on
 * size, format and range still hold.
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
  "display.presenting",
  "display.float",
  "tabs",
  "app.about",
  "app.locale",
  "auth.provider",
  "files.blobUrl",
  "files.stream",
  "share.fileUrl",
  "notifications.push",
] as const;
export type HostBridgeCapability = (typeof HOST_BRIDGE_CAPABILITIES)[number];
export const hostBridgeCapabilitySchema = z.enum(HOST_BRIDGE_CAPABILITIES);

export const hostPlatformSchema = z.enum(["android", "ios", "macos", "windows", "linux", "web", "unknown"]).catch("unknown");
export type HostPlatform = z.infer<typeof hostPlatformSchema>;

const identifier = z.string().min(1).max(128);

const none = z.unknown().transform(() => undefined);

const knownCapabilitiesSchema = z
  .array(z.string().min(1).max(64))
  .max(64)
  .transform((names) =>
    names.filter((name): name is HostBridgeCapability => hostBridgeCapabilitySchema.safeParse(name).success),
  );

export const hostBridgeHelloSchema = z.object({
  type: z.literal("hello"),
  version: z.number().int().positive(),
  platform: hostPlatformSchema,
  hostId: identifier,
  capabilities: knownCapabilitiesSchema,
});
export type HostBridgeHello = z.infer<typeof hostBridgeHelloSchema>;

export const hostDescriptionSchema = hostBridgeHelloSchema.omit({ type: true });
export type HostDescription = z.infer<typeof hostDescriptionSchema>;

export const hostBridgeRequestSchema = z.object({
  type: z.literal("request"),
  id: identifier,
  method: z.string().min(1).max(64),
  params: z.unknown().optional(),
});
export type HostBridgeRequest = z.infer<typeof hostBridgeRequestSchema>;

export const hostBridgeResponseSchema = z.object({
  type: z.literal("response"),
  id: identifier,
  result: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(2_000),
  }).optional(),
});
export type HostBridgeResponse = z.infer<typeof hostBridgeResponseSchema>;

export const hostBridgeEventSchema = z.object({
  type: z.literal("event"),
  name: z.string().min(1).max(64),
  payload: z.unknown().optional(),
});
export type HostBridgeEvent = z.infer<typeof hostBridgeEventSchema>;

export const hostBridgeMessageSchema = z.discriminatedUnion("type", [
  hostBridgeHelloSchema,
  hostBridgeRequestSchema,
  hostBridgeResponseSchema,
  hostBridgeEventSchema,
]);
export type HostBridgeMessage = z.infer<typeof hostBridgeMessageSchema>;

const accessTokenParams = z.object({ forceRefresh: z.boolean().optional() });
const sessionIdentitySchema = z.object({
  authenticated: z.boolean(),
  userUuid: z.string().min(1).max(128).nullable(),
  subject: z.string().min(1).max(255).nullable(),
  email: z.string().max(320).nullable(),
});

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
});
export type DeviceRuntimeInstance = z.infer<typeof deviceRuntimeInstanceSchema>;

export const deviceRuntimeSchema = z.object({
  instances: z.array(deviceRuntimeInstanceSchema).max(256),
});
export type DeviceRuntime = z.infer<typeof deviceRuntimeSchema>;

export const deviceFolderListingSchema = z.object({
  path: devicePath,
  label: deviceLabel,
  parent: devicePath.nullable(),
  spaceId: z.uuid().nullable(),
  folders: z.array(z.object({ name: z.string().min(1).max(255), path: devicePath })).max(10_000),
  volumes: z.array(z.object({ path: devicePath, label: deviceLabel })).max(16),
});
export type DeviceFolderListing = z.infer<typeof deviceFolderListingSchema>;

export const PHONE_CONTROL_STAGES = ["off", "developer", "pairing", "code", "starting", "ready", "stopped"] as const;
export type PhoneControlStage = (typeof PHONE_CONTROL_STAGES)[number];

export const deviceDisplayStatusSchema = z.object({
  sharedWith: z.uuid().nullable(),
  control: z.boolean(),
  error: z.string().min(1).max(64).nullable(),
  phoneControl: z.object({
    stage: z.enum(PHONE_CONTROL_STAGES),
    error: z.string().min(1).max(64).nullable(),
    codeInput: z.boolean().optional(),
    detail: z.string().max(512).optional(),
  }).optional(),
});
export type DeviceDisplayStatus = z.infer<typeof deviceDisplayStatusSchema>;

export const deviceDisplayRefSchema = z.object({ spaceId: z.uuid(), display: displayIdSchema });
export type DeviceDisplayRef = z.infer<typeof deviceDisplayRefSchema>;

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
  })).max(16),
});
export type HostIncomingShare = z.infer<typeof hostIncomingShareSchema>;

export const hostColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

export const HOST_HAPTICS = APP_RUNTIME_HAPTICS;
export type HostHaptic = AppRuntimeHaptic;

export const HOST_FILE_DATA_MAX_LENGTH = 16 * 1024 * 1024;

export const HOST_FILE_FRAME_MAGIC = "CHF1";
export const HOST_FILE_FRAME_HEADER_BYTES = 16;
export const HOST_FILE_STREAM_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** A save streams to disk and may wait on a system sheet, so it outlives ordinary calls. */
export const HOST_FILE_SAVE_TIMEOUT_MS = 60 * 60_000;

/** `id` is chosen by the web side; it correlates `files.progress` events and `files.reveal`. */
const savedFileSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255).optional(),
});

export const hostFileSaveParamsSchema = z.union([
  savedFileSchema.extend({ url: z.url({ protocol: /^https$/ }).max(8_192) }),
  savedFileSchema.extend({ data: z.base64().max(HOST_FILE_DATA_MAX_LENGTH) }),
  savedFileSchema.extend({ blobUrl: z.string().startsWith("blob:").max(2_048) }),
]);

export const hostFileWriteBeginSchema = savedFileSchema.extend({
  size: z.number().int().nonnegative().max(HOST_FILE_STREAM_MAX_BYTES),
});

export const hostFileWriteStartedSchema = z.object({
  channel: z.number().int().positive().max(0xffff_ffff),
  chunkBytes: z.number().int().positive(),
  windowBytes: z.number().int().positive(),
});
export type HostFileWriteStarted = z.infer<typeof hostFileWriteStartedSchema>;
export type HostFileSaveParams = z.infer<typeof hostFileSaveParamsSchema>;

export const HOST_FILE_LOCATIONS = ["downloads", "pictures", "movies", "music", "photos", "files"] as const;
export type HostFileLocation = (typeof HOST_FILE_LOCATIONS)[number];

/** Resolves once the file is on disk; a dismissed system sheet rejects as `canceled`. */
export const hostFileSavedSchema = z.object({
  location: z.enum(HOST_FILE_LOCATIONS),
  revealable: z.boolean(),
});
export type HostFileSaved = z.infer<typeof hostFileSavedSchema>;

export const HOST_FILE_PROGRESS_EVENT = "files.progress" as const;
export const hostFileProgressSchema = z.object({
  id: identifier,
  received: z.number().int().nonnegative(),
  total: z.number().int().positive().nullable(),
});
export type HostFileProgress = z.infer<typeof hostFileProgressSchema>;

const settingParams = z.object({ enabled: z.boolean().optional() });

const inAppPath = z.string().regex(/^\/(?!\/)/, "an in-app path").max(2_048);

export const hostShortcutSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(64),
  path: inAppPath,
});
export type HostShortcut = z.infer<typeof hostShortcutSchema>;

export const hostNotificationSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  body: z.string().max(2_000).optional(),
  path: inAppPath,
});
export type HostNotification = z.infer<typeof hostNotificationSchema>;

export const hostPushSubscriptionSchema = z.object({
  transport: z.enum(["fcm", "apns"]),
  token: z.string().min(1).max(4_096),
});
export type HostPushSubscription = z.infer<typeof hostPushSubscriptionSchema>;

/**
 * What only the page knows about its own tab: `dirty` asks before the tab
 * closes, `attention` marks a background tab until it is shown, and
 * `captureKeys` hands the shell's tab shortcuts to the page while it forwards
 * keys elsewhere, such as a remote screen.
 */
export const hostTabStateSchema = z.object({
  dirty: z.boolean().optional(),
  attention: z.literal(true).optional(),
  captureKeys: z.boolean().optional(),
});
export type HostTabState = z.infer<typeof hostTabStateSchema>;

export const HOST_LOCALES = ["en", "zh-CN"] as const;
export type HostLocale = (typeof HOST_LOCALES)[number];

export const HOST_SIGN_IN_PROVIDERS = ["google", "apple", "facebook"] as const;
export type HostSignInProvider = (typeof HOST_SIGN_IN_PROVIDERS)[number];

export const HOST_AUTH_FLOW_EVENT = "auth.flow" as const;
export const HOST_AUTH_FLOW_OUTCOMES = ["signedIn", "canceled", "failed"] as const;
export const hostAuthFlowSchema = z.object({ outcome: z.enum(HOST_AUTH_FLOW_OUTCOMES) });
export type HostAuthFlow = z.infer<typeof hostAuthFlowSchema>;

export const hostAuthChangedSchema = z.object({
  authenticated: z.boolean(),
  redirectPath: inAppPath.optional(),
});
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
  z.object({ result: z.unknown() }),
  z.object({ error: z.object({ code: z.string().min(1).max(64), message: z.string().max(4_000) }) }),
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

export const HOST_SHARE_SCHEME = "cohub-share";
export const HOST_SHARE_PATH = "/__cohub/share/";

export function hostShareFileUrl(input: { platform: HostPlatform; origin: string; id: string; index: number }) {
  const file = `${encodeURIComponent(input.id)}/${input.index}`;
  return input.platform === "macos" || input.platform === "ios"
    ? `${HOST_SHARE_SCHEME}://${file}`
    : `${input.origin}${HOST_SHARE_PATH}${file}`;
}

export const HOST_SERVICE_WORKSPACE_ENDPOINT = "workspace.endpoint";

export const HOST_SERVICE_CLI_ABOUT = "cli.about";

export type CliAbout = {
  version: string;
  commit: string | null;
  node: string;
  path: { path: string; version: string | null } | null;
  runtimes: { spaceId: string; root: string; version: string | null }[];
};

/**
 * Methods the web surface may call. Both ends validate with these schemas, so
 * a host cannot answer a shape the web side misreads.
 */
export const HOST_BRIDGE_METHODS = {
  "host.describe": { params: none, result: hostDescriptionSchema },
  "auth.getAccessToken": { params: accessTokenParams, result: z.string().min(1).nullable() },
  "auth.getSessionVersion": { params: none, result: z.number().int().nonnegative() },
  "auth.getSession": { params: none, result: sessionIdentitySchema },
  "auth.signIn": {
    params: z.object({
      redirectPath: z.string().max(2_048).optional(),
      provider: z.enum(HOST_SIGN_IN_PROVIDERS).optional(),
    }),
    result: z.boolean(),
  },
  "auth.signOut": { params: none, result: z.boolean() },
  "notifications.register": { params: none, result: z.boolean() },
  "notifications.show": { params: hostNotificationSchema, result: z.boolean() },
  "notifications.subscribe": { params: none, result: hostPushSubscriptionSchema.nullable() },
  "share.text": { params: z.object({ text: z.string().max(100_000), title: z.string().max(512).optional() }), result: z.boolean() },
  "navigation.openPath": { params: z.object({ path: z.string().min(1).max(2_048) }), result: z.boolean() },
  "cache.clear": { params: z.object({ scope: z.enum(["all", "user"]) }), result: z.boolean() },
  "runtime.list": { params: none, result: deviceRuntimeSchema },
  "runtime.browse": { params: z.object({ path: devicePath.optional() }), result: deviceFolderListingSchema },
  "runtime.start": {
    params: z.object({ spaceId: z.uuid(), root: devicePath }),
    result: deviceRuntimeSchema.extend({ refused: z.enum(DEVICE_RUNTIME_REFUSALS).nullable() }),
  },
  "runtime.stop": {
    params: z.object({ spaceId: z.uuid(), force: z.boolean().optional() }),
    result: deviceRuntimeSchema.extend({ refused: z.enum(DEVICE_RUNTIME_STOP_REFUSALS).nullable().optional() }),
  },
  "runtime.pickFolder": { params: z.object({ path: devicePath }).optional(), result: deviceFolderListingSchema },
  "runtime.keepAwake": { params: settingParams, result: z.boolean() },
  "permissions.status": { params: none, result: hostPermissionsSchema },
  "permissions.request": { params: z.object({ kind: hostPermissionSchema }), result: hostPermissionStateSchema },
  "permissions.openSettings": { params: z.object({ kind: hostPermissionSchema }), result: z.boolean() },
  "badge.set": { params: z.object({ count: z.number().int().nonnegative() }), result: z.boolean() },
  "app.launchAtLogin": { params: settingParams, result: z.boolean() },
  "app.globalShortcut": { params: settingParams, result: z.boolean() },
  "app.about": { params: z.object({ web: z.string().min(1).max(64) }), result: z.boolean() },
  "share.take": { params: none, result: hostIncomingShareSchema.nullable() },
  "share.readFile": {
    params: z.object({ id: identifier, index: z.number().int().nonnegative() }),
    result: z.object({ data: z.base64().max(HOST_FILE_DATA_MAX_LENGTH) }),
  },
  "appearance.set": { params: z.object({ backgroundColor: hostColorSchema }), result: z.boolean() },
  "app.ready": { params: none, result: z.boolean() },
  "haptics.perform": { params: z.object({ kind: z.enum(HOST_HAPTICS) }), result: z.boolean() },
  "files.save": { params: hostFileSaveParamsSchema, result: hostFileSavedSchema },
  "files.reveal": { params: z.object({ id: identifier }), result: z.boolean() },
  "files.write.begin": { params: hostFileWriteBeginSchema, result: hostFileWriteStartedSchema },
  "files.write.commit": { params: z.object({ id: identifier }), result: hostFileSavedSchema },
  "files.write.cancel": { params: z.object({ id: identifier }), result: z.boolean() },
  "app.setLocale": { params: z.object({ locale: z.enum(HOST_LOCALES).nullable() }), result: z.boolean() },
  "navigation.interceptBack": { params: z.object({ enabled: z.boolean() }), result: z.boolean() },
  "shortcuts.push": { params: hostShortcutSchema, result: z.boolean() },
  "tabs.update": { params: hostTabStateSchema, result: z.boolean() },
  "display.status": { params: none, result: deviceDisplayStatusSchema },
  "display.share": { params: z.object({ spaceId: z.uuid() }), result: deviceDisplayStatusSchema },
  "display.stop": { params: none, result: deviceDisplayStatusSchema },
  "display.openControlSettings": { params: none, result: z.boolean() },
  "display.setup": { params: none, result: deviceDisplayStatusSchema },
  "display.pair": { params: z.object({ code: z.string().regex(/^\d{6}$/) }), result: deviceDisplayStatusSchema },
  "display.presenting": { params: deviceDisplayRefSchema.optional(), result: z.boolean() },
  "display.float": { params: deviceDisplayRefSchema, result: z.boolean() },
  "workspace.call": {
    params: z.object({
      spaceId: z.uuid(),
      method: z.string().regex(HOST_WORKSPACE_METHOD_PATTERN).max(64),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
    result: workspaceCallResultSchema,
  },
} as const;
export type HostBridgeMethod = keyof typeof HOST_BRIDGE_METHODS;

export const HOST_BRIDGE_EVENTS = ["auth.changed", "auth.signedOut", HOST_AUTH_FLOW_EVENT, "navigation.back", "app.foreground", "app.background", "runtime.changed", "display.changed", "display.open", HOST_FILE_PROGRESS_EVENT] as const;
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
});
export type HostServiceHello = z.infer<typeof hostServiceHelloSchema>;

export const HOST_SERVICE_SHELL_EVENTS = {
  open: "shell.open",
} as const;

export const hostShellOpenSchema = z.object({ url: z.url({ protocol: /^https?$/ }).max(8_192) });

export const HOST_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
export const HOST_BRIDGE_INTERACTIVE_TIMEOUT_MS = 5 * 60_000;
export const HOST_BRIDGE_HANDSHAKE_TIMEOUT_MS = 2_000;
