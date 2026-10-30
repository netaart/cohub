import { isBoardPath } from "./board.js";

export const SPACE_CONFIG_PATH = ".cohub/space.json";

export type WindowKind = "file" | "board" | "port";

export type WindowRef = {
  kind: WindowKind;
  key: string;
};

export type WorkspaceLayoutPresentation = "split" | "focus" | "fullscreen";

export type WorkspaceDefaultLayout = {
  leftSidebar?: "expanded" | "collapsed";
  filesColumn?: "visible" | "hidden";
  fileTree?: "expanded" | "collapsed";
  window?: WindowRef;
  presentation?: WorkspaceLayoutPresentation;
};

type NewChatBackgroundBase = {
  opacity: number;
  fit: "cover" | "contain" | "fill";
  position: string;
};

type NewChatBackgroundUrlSource = {
  kind: "url";
  url: string;
};

export type NewChatBackgroundConfig = NewChatBackgroundBase &
  (
    | {
        type: "html";
        source: NewChatBackgroundUrlSource | { kind: "space"; path: string };
      }
    | {
        type: "image" | "video";
        source: NewChatBackgroundUrlSource;
      }
    | {
        type: "board";
        /** `launch` is a Board launch hash without `#`, e.g. `focus=cover&play=intro`. */
        source: { kind: "space"; path: string; launch?: string };
      }
  );

const BOARD_LAUNCH_MAX_LENGTH = 512;

/**
 * Whether a New Chat background is purely decorative, i.e. safe to hide from
 * assistive technology with `aria-hidden`.
 *
 * Images and videos are decoration. An `html` background is a live document:
 * it can hold focusable controls, announce through live regions, and post
 * `composer.apply` back to the host. Hiding one prunes it from the
 * accessibility tree while its controls stay keyboard-focusable — leaving
 * focus stops a screen reader cannot announce (WCAG 4.1.2). So `html` is
 * treated as content even if a particular page happens to be decorative:
 * over-exposing decoration is a minor annoyance, hiding real controls is a
 * blocker.
 */
export function isDecorativeNewChatBackground(
  background: Pick<NewChatBackgroundConfig, "type">,
): boolean {
  return background.type === "image" || background.type === "video";
}

export type NewChatComposerApplyPayload = {
  prompt?: string;
  model?: {
    provider: string;
    id: string;
  };
  images?: Array<{
    url: string;
    name?: string;
  }>;
};

export type SpaceConfig = {
  ui?: {
    newChat?: {
      background?: NewChatBackgroundConfig;
    };
    workspace?: {
      defaultLayout?: WorkspaceDefaultLayout;
    };
  };
};

export type SpacePreviewSessionCredential = {
  token: string;
  expiresIn: number;
};

export type SpaceStartupResponse = {
  status: "ready" | "missing" | "invalid" | "preparing";
  config: SpaceConfig | null;
  configRaw: string | null;
  revision: { mtimeMs: number; size: number } | null;
  previewSession: SpacePreviewSessionCredential | null;
  retryAfterMs?: number;
};

function isValidPortKey(key: string) {
  if (!/^\d{1,5}$/.test(key)) return false;
  const port = Number(key);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function normalizeWindowPath(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function parseWindow(value: unknown): WindowRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "file" || kind === "board") {
    const key = normalizeWindowPath(record.path ?? record.key);
    return key ? { kind, key } : undefined;
  }
  if (kind === "port") {
    const key =
      typeof record.port === "string" ? record.port : String(record.port ?? "");
    return isValidPortKey(key) ? { kind, key } : undefined;
  }
  return undefined;
}

export function parseWorkspaceDefaultLayout(
  value: unknown,
): WorkspaceDefaultLayout | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const layout: WorkspaceDefaultLayout = {};
  if (record.leftSidebar === "expanded" || record.leftSidebar === "collapsed") {
    layout.leftSidebar = record.leftSidebar;
  }
  if (record.filesColumn === "visible" || record.filesColumn === "hidden") {
    layout.filesColumn = record.filesColumn;
  }
  if (record.fileTree === "expanded" || record.fileTree === "collapsed") {
    layout.fileTree = record.fileTree;
  }
  if (
    record.presentation === "split" ||
    record.presentation === "focus" ||
    record.presentation === "fullscreen"
  ) {
    layout.presentation = record.presentation;
  }
  const window = parseWindow(record.window);
  if (window) layout.window = window;
  return Object.keys(layout).length > 0 ? layout : undefined;
}

function parseBackgroundUrl(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function parseSpacePath(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\.\/+/, "");
  if (!trimmed || trimmed.startsWith("/")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return trimmed;
}

function parseOptionalNumber(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function parseBoardSource(value: unknown) {
  if (typeof value !== "string") return null;
  const hashAt = value.indexOf("#");
  const path = parseSpacePath(hashAt < 0 ? value : value.slice(0, hashAt));
  if (!path || !isBoardPath(path)) return null;
  const launch = hashAt < 0 ? "" : value.slice(hashAt + 1).trim();
  return launch && launch.length <= BOARD_LAUNCH_MAX_LENGTH
    ? { kind: "space" as const, path, launch }
    : { kind: "space" as const, path };
}

function parseBackground(value: unknown): NewChatBackgroundConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.enabled === false) return undefined;
  const url = parseBackgroundUrl(record.url);
  const declared =
    record.type === "image" ||
    record.type === "video" ||
    record.type === "html" ||
    record.type === "board"
      ? record.type
      : null;
  const board =
    !url && (declared === null || declared === "board")
      ? parseBoardSource(record.url)
      : null;
  const type = board ? "board" : (declared ?? "html");
  const spacePath = !url && type === "html" ? parseSpacePath(record.url) : null;
  const common: NewChatBackgroundBase = {
    opacity: parseOptionalNumber(record.opacity, 1, 0, 1),
    fit:
      record.fit === "contain" || record.fit === "fill" || record.fit === "cover"
        ? record.fit
        : "cover",
    position: typeof record.position === "string" ? record.position : "center",
  };
  if (board) return { ...common, type: "board", source: board };
  if (spacePath) {
    return {
      ...common,
      type: "html",
      source: { kind: "space", path: spacePath },
    };
  }
  if (!url || type === "board") return undefined;
  return {
    ...common,
    type,
    source: { kind: "url", url },
  };
}

export function parseSpaceConfig(raw: string): SpaceConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1) return null;
  const ui =
    record.ui && typeof record.ui === "object"
      ? (record.ui as Record<string, unknown>)
      : undefined;
  const newChat =
    ui?.newChat && typeof ui.newChat === "object"
      ? (ui.newChat as Record<string, unknown>)
      : undefined;
  const workspace =
    ui?.workspace && typeof ui.workspace === "object"
      ? (ui.workspace as Record<string, unknown>)
      : undefined;
  const background = parseBackground(newChat?.background);
  const defaultLayout = parseWorkspaceDefaultLayout(workspace?.defaultLayout);
  const config: SpaceConfig = {};
  if (background || defaultLayout) {
    config.ui = {};
    if (background) config.ui.newChat = { background };
    if (defaultLayout) config.ui.workspace = { defaultLayout };
  }
  return config;
}

function objectField(parent: Record<string, unknown>, key: string) {
  const value = parent[key];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${SPACE_CONFIG_PATH}: "${key}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function withNewChatBackground(
  document: Record<string, unknown>,
  background: Record<string, unknown> | null,
): Record<string, unknown> {
  const ui = objectField(document, "ui");
  const { background: _, ...newChat } = objectField(ui, "newChat");
  return {
    ...document,
    ui: { ...ui, newChat: background ? { ...newChat, background } : newChat },
  };
}
