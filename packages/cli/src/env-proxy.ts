import * as http from "node:http";

const PROXY_ENV_KEYS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"] as const;
const USE_ENV_PROXY_FLAG = "--use-env-proxy";

export function proxyEnvPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return PROXY_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}

export function envProxyAlreadyEnabled(
  execArgv: readonly string[] = process.execArgv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (execArgv.includes(USE_ENV_PROXY_FLAG) || env.NODE_USE_ENV_PROXY === "1") return true;
  return (env.NODE_OPTIONS ?? "").split(/\s+/).includes(USE_ENV_PROXY_FLAG);
}

export function supportsUseEnvProxy(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major >= 24 || (major === 22 && minor >= 21);
}

export function shouldRelaunchWithEnvProxy(
  execArgv: readonly string[] = process.execArgv,
  env: NodeJS.ProcessEnv = process.env,
  nodeVersion: string = process.versions.node,
): boolean {
  return supportsUseEnvProxy(nodeVersion) && proxyEnvPresent(env) && !envProxyAlreadyEnabled(execArgv, env);
}

export const envProxyExecArgv = [USE_ENV_PROXY_FLAG] as const;

export function enableEnvProxy(): boolean {
  if (!shouldRelaunchWithEnvProxy()) return true;
  if (typeof http.setGlobalProxyFromEnv !== "function") return false;
  http.setGlobalProxyFromEnv();
  return true;
}
