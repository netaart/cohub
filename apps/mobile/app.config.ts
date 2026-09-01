import type { ConfigContext, ExpoConfig } from "expo/config";

function buildNumberFor(version: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version.trim());
  if (!match) {
    throw new Error(`Native builds require a stable X.Y.Z version, received: ${version}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > 2_099 || minor >= 1_000 || patch >= 1_000) {
    throw new Error(`Version components cannot be encoded into a native build number: ${version}`);
  }
  const buildNumber = major * 1_000_000 + minor * 1_000 + patch;
  if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) {
    throw new Error(`App version cannot produce a valid native build number: ${version}`);
  }
  return buildNumber;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const version = config.version?.trim() || "0.0.1";
  const buildNumber = buildNumberFor(version);
  const googleServicesFile = process.env.COHUB_GOOGLE_SERVICES_FILE?.trim();
  return {
    ...config,
    name: config.name ?? "Cohub",
    slug: config.slug ?? "cohub-mobile",
    version,
    android: {
      ...config.android,
      versionCode: buildNumber,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    ios: {
      ...config.ios,
      buildNumber: String(buildNumber),
    },
  };
};
