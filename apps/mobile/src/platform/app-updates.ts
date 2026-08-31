import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { config } from "@/src/config";

const CACHE_KEY = "cohub:mobile-update-check:v1";
const SNOOZE_KEY = "cohub:mobile-update-snooze:v1";
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;

export type AppRelease = {
  version: string;
  url: string;
  notes: string | null;
  downloadUrl: string | null;
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
    return url.protocol === "https:" && (url.hostname === "github.com" || url.hostname === "www.github.com");
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
  return (
    Application.nativeApplicationVersion?.trim() ||
    Constants.expoConfig?.version?.trim() ||
    "0.0.0"
  );
}

function resolveDownloadUrl(payload: Record<string, unknown>) {
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
  return asset.browser_download_url.trim() || null;
}

function releaseFromPayload(payload: unknown): AppRelease | null {
  if (!isRecord(payload)) return null;
  const tag = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
  const url = typeof payload.html_url === "string" ? payload.html_url.trim() : "";
  const draft = payload.draft === true;
  const prerelease = payload.prerelease === true;
  if (!tag || !url || !isAllowedReleaseUrl(url) || draft || prerelease || !parseVersion(tag)) return null;

  return {
    version: tag.replace(/^v/, ""),
    url,
    notes: typeof payload.body === "string" && payload.body.trim() ? payload.body.trim() : null,
    downloadUrl: resolveDownloadUrl(payload),
  };
}

function parseCachedCheck(value: unknown): CachedCheck | null {
  if (!isRecord(value) || typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt) || !isRecord(value.release)) return null;
  const rawRelease = value.release;
  const version = typeof rawRelease.version === "string" ? rawRelease.version.trim() : "";
  const url = typeof rawRelease.url === "string" ? rawRelease.url.trim() : "";
  const notes = rawRelease.notes == null ? null : typeof rawRelease.notes === "string" ? rawRelease.notes : null;
  const downloadUrl = rawRelease.downloadUrl == null ? null : typeof rawRelease.downloadUrl === "string" ? rawRelease.downloadUrl.trim() || null : null;
  if (!version || !parseVersion(version) || !isAllowedReleaseUrl(url)) return null;
  if (downloadUrl && !isAllowedReleaseUrl(downloadUrl)) return null;
  return { checkedAt: value.checkedAt, release: { version, url, notes, downloadUrl } };
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
      cachedCheck.checkedAt <= Date.now() &&
      Date.now() - cachedCheck.checkedAt < CHECK_TTL_MS
    ) {
      return isNewerAppVersion(currentVersion, cachedCheck.release.version)
        ? cachedCheck.release
        : null;
    }
  }
  if (request && !options.force) return request;

  request = requestLatestRelease()
    .then((latest) => {
      cachedCheck = { checkedAt: Date.now(), release: latest };
      persistCheck(cachedCheck);
      return isNewerAppVersion(currentVersion, latest.version) ? latest : null;
    })
    .finally(() => {
      request = null;
    });
  return request;
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
