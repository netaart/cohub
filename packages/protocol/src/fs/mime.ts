import { BOARD_EXTENSION, BOARD_MIME_TYPE } from "../board.js";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".abc": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".csv": "text/csv",
  [BOARD_EXTENSION]: BOARD_MIME_TYPE,
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".jsx": "text/jsx",
  ".svelte": "text/x-svelte",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".env": "text/plain",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java-source",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++src",
  ".hpp": "text/x-c++hdr",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".ogv": "video/ogg",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".stl": "model/stl",
  ".obj": "model/obj",
  ".3mf": "model/3mf",
  ".usdz": "model/vnd.usdz+zip",
  ".mtl": "text/plain",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".exe": "application/x-msdownload",
  ".dmg": "application/x-apple-diskimage",
  ".deb": "application/vnd.debian.binary-package",
  ".rpm": "application/x-rpm",
};

const MIME_BY_FILENAME: Readonly<Record<string, string>> = {
  dockerfile: "text/x-dockerfile",
  makefile: "text/x-makefile",
};

export function mimeTypeForPath(path: string): string | null {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const byName = Object.hasOwn(MIME_BY_FILENAME, name) ? MIME_BY_FILENAME[name] : undefined;
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  const byExtension = dot > 0 ? MIME_BY_EXTENSION[name.slice(dot)] : undefined;
  if (byExtension) return byExtension;
  return name.startsWith(".") ? "text/plain" : null;
}

export function normalizeMime(mimeType: string | null | undefined): string | null {
  if (!mimeType) return null;
  const base = mimeType.split(";")[0]?.trim().toLowerCase();
  return base || null;
}

const TEXT_APPLICATION_MIMES = new Set([
  "application/json",
  "application/csv",
  "application/xml",
  "application/yaml",
  "application/toml",
  "application/sql",
  "application/x-ndjson",
]);

export function isTextMime(mimeType: string | null | undefined): boolean {
  const mime = normalizeMime(mimeType);
  return Boolean(mime && (mime.startsWith("text/") || TEXT_APPLICATION_MIMES.has(mime)));
}

export function isModelMime(mimeType: string | null | undefined): boolean {
  return normalizeMime(mimeType)?.startsWith("model/") ?? false;
}

export type ModelFormat = "glb" | "gltf" | "stl" | "obj";

const MODEL_FORMAT_BY_MIME: Readonly<Record<string, ModelFormat>> = {
  "model/gltf-binary": "glb",
  "model/gltf+json": "gltf",
  "model/stl": "stl",
  "model/obj": "obj",
};

export function modelFormatForPath(path: string, mimeType?: string | null): ModelFormat | null {
  const format = (mime: string | null | undefined) => {
    const key = normalizeMime(mime);
    return key && Object.hasOwn(MODEL_FORMAT_BY_MIME, key) ? MODEL_FORMAT_BY_MIME[key] : undefined;
  };
  return format(mimeTypeForPath(path)) ?? format(mimeType) ?? null;
}
