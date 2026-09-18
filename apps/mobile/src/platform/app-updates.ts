import { translate } from "@/src/i18n/core";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { config } from "@/src/config";
import {
  githubReleaseUrl,
  isAllowedAndroidUpdateUrl,
  selectYaotaAndroidUpdate,
  validateAndroidUpdateAsset,
  verifyAndroidUpdateIntegrity,
  type AndroidUpdateAbi,
} from "@/src/data/update-assets";

const CACHE_KEY = "cohub:mobile-update-check:v4";
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
  release: AppRelease | null;
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

function deviceAbi(): AndroidUpdateAbi | null {
  const architectures = (Device.supportedCpuArchitectures ?? []).map((value) => value.toLowerCase());
  if (architectures.some((value) => value.includes("arm64") || value.includes("aarch64"))) return "arm64-v8a";
  if (architectures.some((value) => value.includes("armeabi-v7a") || value.includes("armv7"))) return "armeabi-v7a";
  if (architectures.some((value) => value.includes("x86_64") || value.includes("x86-64") || value.includes("amd64"))) return "x86_64";
  if (architectures.some((value) => value.includes("x86"))) return "x86";
  return null;
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
  return Application.nativeApplicationVersion?.trim() || Constants.expoConfig?.version?.trim() || "0.0.0";
}

function parseCachedCheck(value: unknown): CachedCheck | null {
  if (!isRecord(value) || typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) return null;
  if (value.release === null) return { checkedAt: value.checkedAt, release: null };
  if (!isRecord(value.release)) return null;
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
  if (!version || !parseVersion(version) || url !== githubReleaseUrl(version)) return null;
  if (downloadUrl && !isAllowedAndroidUpdateUrl(config.apkOrigin, downloadUrl)) return null;
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

async function requestNativeRelease(): Promise<AppRelease | null> {
  if (Platform.OS !== "android") return null;
  const abi = deviceAbi();
  if (!abi) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const origin = config.apkOrigin.replace(/\/+$/, "");
    const response = await fetch(`${origin}/api/ota/catalog?app_id=cohub-mobile`, { headers: { Accept: "application/json", "expo-app-id": "cohub-mobile" }, signal: controller.signal });
    if (!response.ok) throw new Error(`Update check failed with HTTP ${response.status}`);
    const payload: unknown = await response.json();
    return selectYaotaAndroidUpdate(payload, config.apkOrigin, abi);
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
      cachedCheck.checkedAt <= Date.now() &&
      Date.now() - cachedCheck.checkedAt < CHECK_TTL_MS
    ) {
      return cachedCheck.release && isNewerAppVersion(currentVersion, cachedCheck.release.version)
        ? cachedCheck.release
        : null;
    }
  }
  if (request && !options.force) return request;

  const nextRequest = requestNativeRelease()
    .then((latest) => {
      cachedCheck = { checkedAt: Date.now(), release: latest };
      persistCheck(cachedCheck);
      return latest && isNewerAppVersion(currentVersion, latest.version) ? latest : null;
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
    throw new Error(translate("update.permissionStandalone"));
  }
  if (!Application.applicationId) throw new Error(translate("update.packageIdMissing"));
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
    throw new Error(translate("update.installRequiresStandalone"));
  }
  if (apkUpdateInProgress) throw new Error(translate("update.inProgress"));
  if (!isNewerAppVersion(getInstalledAppVersion(), release.version)) {
    throw new Error(translate("update.notNewer"));
  }
  const asset = validateAndroidUpdateAsset(release, config.apkOrigin);
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
      if (file.size !== asset.size) throw new Error(translate("update.sizeVerifyFailed"));
      // expo-crypto's Android binding only accepts a TypedArray; a bare ArrayBuffer fails to convert.
      const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(await file.arrayBuffer()));
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
