import type { ConfigContext, ExpoConfig } from "expo/config";

function otaRuntimeVersion() {
  const override = process.env.COHUB_OTA_RUNTIME_VERSION?.trim();
  if (!override) return { policy: "fingerprint" } as const;
  if (!/^[a-f0-9]{40,64}$/.test(override)) {
    throw new Error("COHUB_OTA_RUNTIME_VERSION must be the native fingerprint hash from the installed native build.");
  }
  return override;
}

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
  const updatesUrl = process.env.EXPO_PUBLIC_UPDATES_URL?.trim();
  if (updatesUrl) {
    let url: URL;
    try {
      url = new URL(updatesUrl);
    } catch {
      throw new Error("EXPO_PUBLIC_UPDATES_URL must be an absolute HTTPS Expo Updates endpoint.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error("EXPO_PUBLIC_UPDATES_URL must use HTTPS without credentials or a fragment.");
    }
  }
  return {
    ...config,
    name: config.name ?? "Cohub",
    slug: config.slug ?? "cohub-mobile",
    version,
    runtimeVersion: otaRuntimeVersion(),
    updates: updatesUrl
      ? {
          ...config.updates,
          enabled: true,
          url: updatesUrl,
          checkAutomatically: "ON_LOAD",
          fallbackToCacheTimeout: 0,
          requestHeaders: { "expo-app-id": "cohub-mobile", "expo-channel-name": "production" },
          codeSigningCertificate: "./certs/ota-certificate.crt",
          codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
        }
      : { enabled: false },
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
