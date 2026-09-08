import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { config } from "@/src/config";
import { validateAndroidUpdateAsset, verifyAndroidUpdateIntegrity } from "@/src/data/update-assets";

const CACHE_KEY = "cohub:mobile-update-check:v2";
const SNOOZE_KEY = "cohub:mobile-update-snooze:v1";
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;

export type AppRelease = {
  version: string;
  title: string | null;
  publishedAt: string | null;
  url: string;
  notes: string | null;
  downloadUrl: string | null;
  downloadName: string | null;
  downloadSize: number | null;
  downloadSha256: string | null;
};

type CachedCheck = {
  checkedAt: number;
  release: AppRelease;
};

type SnoozeRecord = {
  version: string;
  until: number;
};

let cachedCheck: CachedCheck | null = null;
let persistedCacheRead: Promise<void> | null = null;
let request: Promise<AppRelease | null> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVersion(value: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function isAllowedReleaseUrl(value: string) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    return url.protocol === "https:" &&
      (url.hostname === "github.com" || url.hostname === "www.github.com") &&
      (path === "/markbang/cohub-mobile/releases" || path.startsWith("/markbang/cohub-mobile/releases/"));
  } catch {
    return false;
  }
}

export function isNewerAppVersion(current: string, latest: string) {
  const currentParts = parseVersion(current);
  const latestParts = parseVersion(latest);
  if (!currentParts || !latestParts) return false;
  for (let index = 0; index < currentParts.length; index += 1) {
    if (latestParts[index] !== currentParts[index]) {
      return latestParts[index] > currentParts[index];
    }
  }
  return false;
}

export function getInstalledAppVersion() {
  if (Platform.OS === "web") return Constants.expoConfig?.version?.trim() || "0.0.0";
  return Application.nativeApplicationVersion?.trim() || Constants.expoConfig?.version?.trim() || "0.0.0";
}

function resolveDownloadAsset(payload: Record<string, unknown>) {
  if (Platform.OS !== "android") return null;
  const architectures = (Device.supportedCpuArchitectures ?? []).map((value) => value.toLowerCase());
  const abi = architectures.some((value) => value.includes("arm64") || value.includes("aarch64"))
    ? "arm64-v8a"
    : architectures.some((value) => value.includes("armeabi-v7a") || value.includes("armv7"))
      ? "armeabi-v7a"
      : architectures.some((value) => value.includes("x86_64") || value.includes("x86-64") || value.includes("amd64"))
        ? "x86_64"
        : architectures.some((value) => value.includes("x86"))
          ? "x86"
          : null;
  if (!abi || !Array.isArray(payload.assets)) return null;
  const asset = payload.assets.find((item) => {
    if (!isRecord(item)) return false;
    const name = typeof item.name === "string" ? item.name : "";
    const url = typeof item.browser_download_url === "string" ? item.browser_download_url.trim() : "";
    return name.endsWith(`android-${abi}.apk`) && isAllowedReleaseUrl(url);
  });
  if (!isRecord(asset) || typeof asset.browser_download_url !== "string") return null;
  const url = asset.browser_download_url.trim();
  if (!url) return null;
  const name = typeof asset.name === "string" ? asset.name.trim() || null : null;
  const size = typeof asset.size === "number" && Number.isFinite(asset.size) && asset.size >= 0 ? asset.size : null;
  const sha256 = typeof asset.digest === "string"
    ? /^sha256:([a-f0-9]{64})$/i.exec(asset.digest)?.[1].toLowerCase() ?? null
    : null;
  return { url, name, size, sha256 };
}

function releaseFromPayload(payload: unknown): AppRelease | null {
  if (!isRecord(payload)) return null;
  const tag = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
  const url = typeof payload.html_url === "string" ? payload.html_url.trim() : "";
  const draft = payload.draft === true;
  const prerelease = payload.prerelease === true;
  if (!tag || !url || !isAllowedReleaseUrl(url) || draft || prerelease || !parseVersion(tag)) return null;
  const download = resolveDownloadAsset(payload);
  const publishedAt = typeof payload.published_at === "string" && !Number.isNaN(Date.parse(payload.published_at))
    ? payload.published_at
    : null;

  return {
    version: tag.replace(/^v/, ""),
    title: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : null,
    publishedAt,
    url,
    notes: typeof payload.body === "string" && payload.body.trim() ? payload.body.trim() : null,
    downloadUrl: download?.url ?? null,
    downloadName: download?.name ?? null,
    downloadSize: download?.size ?? null,
    downloadSha256: download?.sha256 ?? null,
  };
}

function parseCachedCheck(value: unknown): CachedCheck | null {
  if (!isRecord(value) || typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt) || !isRecord(value.release)) return null;
  const rawRelease = value.release;
  const version = typeof rawRelease.version === "string" ? rawRelease.version.trim() : "";
  const title = typeof rawRelease.title === "string" ? rawRelease.title.trim() || null : null;
  const publishedAt = typeof rawRelease.publishedAt === "string" && !Number.isNaN(Date.parse(rawRelease.publishedAt))
    ? rawRelease.publishedAt
    : null;
  const url = typeof rawRelease.url === "string" ? rawRelease.url.trim() : "";
  const notes = rawRelease.notes == null ? null : typeof rawRelease.notes === "string" ? rawRelease.notes : null;
  const downloadUrl = Platform.OS === "android" && rawRelease.downloadUrl != null
    ? typeof rawRelease.downloadUrl === "string" ? rawRelease.downloadUrl.trim() || null : null
    : null;
  const downloadName = Platform.OS === "android" && typeof rawRelease.downloadName === "string"
    ? rawRelease.downloadName.trim() || null
    : null;
  const downloadSize = Platform.OS === "android" && typeof rawRelease.downloadSize === "number" && Number.isFinite(rawRelease.downloadSize) && rawRelease.downloadSize >= 0
    ? rawRelease.downloadSize
    : null;
  const downloadSha256 = typeof rawRelease.downloadSha256 === "string" && /^[a-f0-9]{64}$/i.test(rawRelease.downloadSha256)
    ? rawRelease.downloadSha256.toLowerCase()
    : null;
  if (!version || !parseVersion(version) || !isAllowedReleaseUrl(url)) return null;
  if (downloadUrl && !isAllowedReleaseUrl(downloadUrl)) return null;
  return {
    checkedAt: value.checkedAt,
    release: { version, title, publishedAt, url, notes, downloadUrl, downloadName, downloadSize, downloadSha256 },
  };
}

async function loadPersistedCache() {
  if (cachedCheck) return;
  if (persistedCacheRead) {
    await persistedCacheRead;
    return;
  }

  const read = AsyncStorage.getItem(CACHE_KEY)
    .then((raw) => {
      if (!raw || cachedCheck) return;
      try {
        const parsed = parseCachedCheck(JSON.parse(raw));
        if (parsed) cachedCheck = parsed;
      } catch {
        // Ignore malformed local cache and use the network result.
      }
    })
    .catch(() => undefined);
  persistedCacheRead = read;
  try {
    await read;
  } finally {
    if (persistedCacheRead === read) persistedCacheRead = null;
  }
}

function persistCheck(value: CachedCheck) {
  void AsyncStorage.setItem(CACHE_KEY, JSON.stringify(value)).catch(() => undefined);
}

async function requestLatestRelease() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.updateApiUrl, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Update check failed with HTTP ${response.status}`);
    const release = releaseFromPayload(await response.json());
    if (!release) throw new Error("Update response did not contain a stable release");
    return release;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkForAppUpdate(options: { force?: boolean } = {}) {
  const currentVersion = getInstalledAppVersion();
  if (!options.force) {
    await loadPersistedCache();
    if (
      cachedCheck &&
      (Platform.OS !== "android" || cachedCheck.release.downloadSha256 !== null) &&
      cachedCheck.checkedAt <= Date.now() &&
      Date.now() - cachedCheck.checkedAt < CHECK_TTL_MS
    ) {
      return isNewerAppVersion(currentVersion, cachedCheck.release.version)
        ? cachedCheck.release
        : null;
    }
  }
  if (request && !options.force) return request;

  const nextRequest = requestLatestRelease()
    .then((latest) => {
      cachedCheck = { checkedAt: Date.now(), release: latest };
      persistCheck(cachedCheck);
      return isNewerAppVersion(currentVersion, latest.version) ? latest : null;
    })
    .finally(() => {
      if (request === nextRequest) request = null;
    });
  request = nextRequest;
  return nextRequest;
}

function parseSnooze(value: string | null): SnoozeRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || typeof parsed.version !== "string" || typeof parsed.until !== "number") return null;
    return parseVersion(parsed.version) && Number.isFinite(parsed.until)
      ? { version: parsed.version, until: parsed.until }
      : null;
  } catch {
    return null;
  }
}

export async function isUpdateSnoozed(version: string) {
  const record = parseSnooze(await AsyncStorage.getItem(SNOOZE_KEY));
  if (!record || record.version !== version) return false;
  if (record.until <= Date.now()) {
    await AsyncStorage.removeItem(SNOOZE_KEY).catch(() => undefined);
    return false;
  }
  return true;
}

export async function snoozeAppUpdate(version: string) {
  await AsyncStorage.setItem(SNOOZE_KEY, JSON.stringify({
    version,
    until: Date.now() + SNOOZE_DURATION_MS,
  } satisfies SnoozeRecord));
}

export async function openAndroidInstallPermissionSettings(): Promise<void> {
  if (Platform.OS !== "android" || Constants.executionEnvironment === "storeClient") {
    throw new Error("Installation permission requires a standalone Android build.");
  }
  if (!Application.applicationId) throw new Error("The installed Android package identifier is unavailable.");
  const IntentLauncher = await import("expo-intent-launcher");
  await IntentLauncher.startActivityAsync("android.settings.MANAGE_UNKNOWN_APP_SOURCES", {
    data: `package:${Application.applicationId}`,
  });
}

export type ApkUpdateProgress =
  | { phase: "downloading"; fraction: number }
  | { phase: "verifying" | "installing" };

let apkUpdateInProgress = false;

export async function downloadAndInstallAndroidUpdate(
  release: AppRelease,
  options: { signal: AbortSignal; onProgress: (progress: ApkUpdateProgress) => void },
): Promise<void> {
  if (Platform.OS !== "android" || Constants.executionEnvironment === "storeClient") {
    throw new Error("APK installation requires a standalone Android build, not Expo Go.");
  }
  if (apkUpdateInProgress) throw new Error("An update is already in progress. Finish or cancel it first.");
  if (!isNewerAppVersion(getInstalledAppVersion(), release.version)) {
    throw new Error("This release is not newer than the installed app. Check for updates again.");
  }
  const asset = validateAndroidUpdateAsset(release);
  apkUpdateInProgress = true;
  try {
    const { Directory, File, Paths } = await import("expo-file-system");
    const Crypto = await import("expo-crypto");
    const IntentLauncher = await import("expo-intent-launcher");
    const directory = new Directory(Paths.cache, "app-updates");
    const file = new File(directory, `${asset.sha256}.apk`);
    let verified = false;
    try {
      if (options.signal.aborted) return;
      directory.create({ idempotent: true, intermediates: true });
      for (const entry of directory.list()) {
        if (entry.uri !== file.uri) entry.delete();
      }
      if (!file.exists) {
        await File.downloadFileAsync(asset.url, file, {
          signal: options.signal,
          onProgress: ({ bytesWritten }) => options.onProgress({
            phase: "downloading",
            fraction: Math.min(1, Math.max(0, bytesWritten / asset.size)),
          }),
        });
      }
      if (options.signal.aborted) return;
      options.onProgress({ phase: "verifying" });
      if (file.size !== asset.size) throw new Error("APK size verification failed. Retry the download.");
      const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, await file.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      verifyAndroidUpdateIntegrity(asset, { size: file.size, sha256 });
      verified = true;
      if (options.signal.aborted) return;
      options.onProgress({ phase: "installing" });
      await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
        data: file.contentUri,
        type: "application/vnd.android.package-archive",
        // Grant temporary read access without NEW_TASK, so the installer can return to Cohub.
        flags: 1,
      });
      // Returning is not proof of installation. Keep the verified APK for a retry.
    } finally {
      if (!verified && file.exists) file.delete();
    }
  } finally {
    apkUpdateInProgress = false;
  }
}
