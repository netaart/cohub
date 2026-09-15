export const ANDROID_UPDATE_ABIS = ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"] as const;
export type AndroidUpdateAbi = (typeof ANDROID_UPDATE_ABIS)[number];

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ABI = /^(arm64-v8a|armeabi-v7a|x86|x86_64)$/;

export type AndroidUpdateAsset = {
  version: string;
  downloadUrl: string | null;
  downloadName: string | null;
  downloadSize: number | null;
  downloadSha256: string | null;
};

export type YaotaAndroidRelease = {
  version: string;
  title: string | null;
  publishedAt: string | null;
  url: string;
  notes: string | null;
  downloadUrl: string;
  downloadName: string;
  downloadSize: number;
  downloadSha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAndroidUpdateAbi(value: string): value is AndroidUpdateAbi {
  return ABI.test(value);
}

export function androidUpdateOrigin(origin: string) {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("The APK distribution origin is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error("The APK distribution origin must be an HTTPS origin.");
  }
  return url.origin;
}

export function androidUpdateApkName(version: string, abi: AndroidUpdateAbi) {
  return `cohub-v${version}-android-${abi}.apk`;
}

export function androidUpdateApkUrl(origin: string, version: string, abi: AndroidUpdateAbi) {
  return `${androidUpdateOrigin(origin)}/apk/${androidUpdateApkName(version, abi)}`;
}

export function isAllowedAndroidUpdateUrl(origin: string, value: string) {
  try {
    const expected = androidUpdateOrigin(origin);
    const url = new URL(value);
    if (url.origin !== expected || url.search || url.hash) return false;
    const match = /^\/apk\/cohub-v([0-9.]+)-android-(arm64-v8a|armeabi-v7a|x86|x86_64)\.apk$/.exec(url.pathname);
    return Boolean(match && VERSION.test(match[1] ?? "") && isAndroidUpdateAbi(match[2] ?? ""));
  } catch {
    return false;
  }
}

export function githubReleaseUrl(version: string) {
  if (!VERSION.test(version)) throw new Error("The update has an invalid release version. Check for updates again.");
  return `https://github.com/markbang/cohub-mobile/releases/tag/v${version}`;
}

export function validateAndroidUpdateAsset(asset: AndroidUpdateAsset, origin: string): {
  url: string;
  name: string;
  size: number;
  sha256: string;
} {
  if (!VERSION.test(asset.version)) {
    throw new Error("The update has an invalid release version. Check for updates again.");
  }
  const name = asset.downloadName;
  const prefix = `cohub-v${asset.version}-android-`;
  const abi = name?.startsWith(prefix) && name.endsWith(".apk") ? name.slice(prefix.length, -4) : null;
  if (!name || !abi || !isAndroidUpdateAbi(abi)) {
    throw new Error("This release does not include a valid APK for this device. Check for updates again.");
  }
  const url = androidUpdateApkUrl(origin, asset.version, abi);
  if (asset.downloadUrl !== url) {
    throw new Error("The APK download URL does not match the published distribution. Check for updates again.");
  }
  const size = asset.downloadSize;
  if (size === null || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error("The APK size is missing or invalid. Check for updates again.");
  }
  const sha256 = asset.downloadSha256;
  if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error("The release is missing a SHA-256 digest. Check for updates again after the APK upload completes.");
  }
  return { url, name, size, sha256: sha256.toLowerCase() };
}

export function verifyAndroidUpdateIntegrity(
  expected: { size: number; sha256: string },
  actual: { size: number; sha256: string },
): void {
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new Error("APK verification failed. The downloaded file was removed; retry the download.");
  }
}

function parseVersion(value: string) {
  const match = VERSION.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function isNewerVersion(current: string, latest: string) {
  const currentParts = parseVersion(current);
  const latestParts = parseVersion(latest);
  if (!currentParts || !latestParts) return false;
  for (let index = 0; index < currentParts.length; index += 1) {
    if (latestParts[index] !== currentParts[index]) return latestParts[index] > currentParts[index];
  }
  return false;
}

function apkFromYaotaRecord(value: unknown, origin: string, abi: AndroidUpdateAbi): YaotaAndroidRelease | null {
  if (!isRecord(value)) return null;
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const arch = typeof value.arch === "string" ? value.arch.trim() : "";
  const status = typeof value.status === "string" ? value.status.trim() : "Available";
  const size = typeof value.size === "number" ? value.size : typeof value.size === "string" ? Number(value.size) : NaN;
  const sha256 = typeof value.sha256 === "string" ? value.sha256.trim().toLowerCase() : "";
  const publishedAt = typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    ? value.createdAt
    : null;
  if (!VERSION.test(version) || arch !== abi || status !== "Available") return null;
  if (!Number.isSafeInteger(size) || size <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  const name = androidUpdateApkName(version, abi);
  const downloadUrl = androidUpdateApkUrl(origin, version, abi);
  if (typeof value.url === "string" && value.url.trim() !== downloadUrl) return null;
  return {
    version,
    title: null,
    publishedAt,
    url: githubReleaseUrl(version),
    notes: null,
    downloadUrl,
    downloadName: name,
    downloadSize: size,
    downloadSha256: sha256,
  };
}

export function selectYaotaAndroidUpdate(payload: unknown, origin: string, abi: AndroidUpdateAbi): YaotaAndroidRelease | null {
  androidUpdateOrigin(origin);
  if (!isRecord(payload) || !Array.isArray(payload.apks)) throw new Error("The update catalog is invalid.");
  let newest: YaotaAndroidRelease | null = null;
  for (const item of payload.apks) {
    const release = apkFromYaotaRecord(item, origin, abi);
    if (!release) continue;
    if (!newest || isNewerVersion(newest.version, release.version)) newest = release;
  }
  return newest;
}
