import apps from "./native-apps.json" with { type: "json" };

export type NativeDeployment = {
  appName: string;
  webOrigin: string;
  apiOrigin: string;
  gatewayOrigin: string;
  logtoEndpoint: string;
  logtoAppId: string;
  urlScheme: string;
  ios: { bundleId: string };
  android: { packageName: string; fingerprints: string[] };
};

export type NativeApps = {
  appleTeamId: string;
  logtoApiResource: string;
  deployments: Record<string, NativeDeployment>;
  paths: { authCallback: string; oneShot: string[]; landing: string[]; browserOnly: string[] };
  externalSchemes: string[];
};

export const NATIVE_APPS: NativeApps = apps;

export function nativeDeployment(env: string | undefined): NativeDeployment | undefined {
  const key = env?.trim().toLowerCase() ?? "";
  return Object.hasOwn(NATIVE_APPS.deployments, key) ? NATIVE_APPS.deployments[key] : undefined;
}

export function browserOnlyPatterns(): string[] {
  return NATIVE_APPS.paths.browserOnly.flatMap((path) => (path.endsWith("/") ? [`${path}*`] : [path, `${path}/*`]));
}
