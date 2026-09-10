export type AndroidUpdateAsset = {
  version: string;
  downloadUrl: string | null;
  downloadName: string | null;
  downloadSize: number | null;
  downloadSha256: string | null;
};

export function validateAndroidUpdateAsset(asset: AndroidUpdateAsset): {
  url: string;
  name: string;
  size: number;
  sha256: string;
} {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(asset.version)) {
    throw new Error("The update has an invalid release version. Check for updates again.");
  }
  const name = asset.downloadName;
  const prefix = `cohub-v${asset.version}-android-`;
  if (!name?.startsWith(prefix) || !/^(arm64-v8a|armeabi-v7a|x86|x86_64)\.apk$/.test(name.slice(prefix.length))) {
    throw new Error("This release does not include a valid APK for this device. Check for updates again.");
  }
  const url = `https://github.com/markbang/cohub-mobile/releases/download/v${asset.version}/${name}`;
  if (asset.downloadUrl !== url) {
    throw new Error("The APK download URL does not match the published release. Check for updates again.");
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
