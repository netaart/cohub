import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The works REST surface is frozen wire contract: external consumers (e.g.
 * neta-studio) and older SDK versions call `/api/works*` paths and read
 * response field names like `work` / `works` / `workScopes` / `workId`
 * directly. The routes are dual-mounted — canonical `/api/apps` for new SDK
 * clients, legacy `/api/works` for existing ones — with identical payloads.
 *
 * Route-level integration tests are impractical here (the route module wires
 * db/redis at import time), so this contract test instead extracts both sides
 * from source and matches them: every path the SDK (and web's direct calls)
 * requests must be mounted under the canonical prefix, and its legacy twin
 * must be mounted too. Renaming a mount prefix or an internal path — without
 * the matching SDK change — fails here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(HERE, "..", "..");
const REPO_ROOT = join(API_ROOT, "..", "..");

const read = (...segments: string[]) => readFileSync(join(...segments), "utf-8");

const SDK_SOURCES = [
  "packages/sdk/src/apis/apps.ts",
  "packages/sdk/src/apis/app-commerce.ts",
  "packages/sdk/src/apis/app-realtime.ts",
  "packages/sdk/src/app-bridge-core.ts",
  "packages/sdk/src/app-runtime.ts",
];

/** Web-side direct calls (SSR + broker page) that bypass the SDK. */
const WEB_DIRECT_PATHS = [
  "/api/apps/by-origin",
  "/api/apps/by-slug/:p/:p/:p",
  "/api/apps/:p/public",
];

/** Canonical -> legacy prefix pairs kept mounted with identical payloads. */
const LEGACY_PREFIXES: Array<[canonical: string, legacy: string]> = [
  ["/api/apps", "/api/works"],
  ["/api/desktop/commands", "/api/ui/commands"],
];

/** Normalize a template string: `${...}` interpolations become `:p` segments. */
function normalizePath(raw: string): string {
  return raw
    .replace(/\$\{[^}]*\}/g, ":p")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

/** Extract every `/api/...` request path a source file mentions. */
function extractApiPaths(source: string): string[] {
  const paths: string[] = [];
  for (const match of source.matchAll(/[`"'](\/api\/[^`"']*)[`"']/g)) {
    paths.push(normalizePath(match[1] ?? ""));
  }
  return paths;
}

/** One route segment matches when both are parameters or both are equal. */
function segmentsMatch(routeSegments: string[], pathSegments: string[]): boolean {
  return (
    routeSegments.length === pathSegments.length &&
    routeSegments.every(
      (segment, index) =>
        (segment.startsWith(":") && pathSegments[index]?.startsWith(":")) ||
        segment === pathSegments[index],
    )
  );
}

/** Build the full mounted route table from routes/index.ts + route files. */
function mountedRoutes(): string[] {
  const indexSource = read(API_ROOT, "src", "routes", "index.ts")
    // Commented-out mounts must not count as live routes.
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const imports = new Map<string, string>();
  for (const match of indexSource.matchAll(/import\s+\{?\s*(\w+)\s*\}?\s+from\s+"\.\/([^"]+)"/g)) {
    imports.set(match[1] ?? "", join(API_ROOT, "src", "routes", `${(match[2] ?? "").replace(/\.js$/, "")}.ts`));
  }

  const ROUTE_FILES: Record<string, string> = {
    AppsRouter: "apps.route.ts",
    AppPromotionsRouter: "app-promotions.route.ts",
    AppCommerceRouter: "app-commerce.route.ts",
  };

  const mounted: string[] = [];
  const registerFile = (prefix: string, file: string, resource?: string) => {
    const routeSource = readFileSync(file, "utf-8");
    for (const inner of routeSource.matchAll(
      /\.route\(\s*"(?<sub>\/[^"]*)"\s*,\s*\w+\s*\)|\.(?:get|post|patch|put|delete)\(\s*[`"](?<path>\/[^`"]*)[`"]/g,
    )) {
      let path = inner.groups?.sub ?? inner.groups?.path ?? "";
      if (resource) path = path.replaceAll(`\${resource}`, resource);
      mounted.push(path && path !== "/" ? normalizePath(`${prefix}${path}`) : normalizePath(prefix));
    }
    for (const sub of routeSource.matchAll(/\.route\(\s*"(\/[^"]*)"\s*,\s*(create\w+Router)\((?:wire)?\)\s*\)/g)) {
      const from = routeSource.match(new RegExp(`import\\s*\\{[^}]*\\b${sub[2]}\\b[^}]*\\}\\s*from\\s*"\\./([^"]+)\\.js"`));
      if (from) registerFile(`${prefix}${sub[1] === "/" ? "" : sub[1]}`, join(dirname(file), `${from[1]}.ts`), resource);
    }
  };

  for (const match of indexSource.matchAll(
    /router\.route\("([^"]+)",\s*(\w+|create\w+Router\("\w+"\))\)/g,
  )) {
    const target = match[2] ?? "";
    const factory = target.match(/create(\w+Router)(?:\("(\w+)"\))?/);
    if (factory) {
      const file = ROUTE_FILES[factory[1] ?? ""];
      // Commerce paths embed the resource segment: /works/:id/... or /apps/:id/...
      if (file) registerFile(match[1] ?? "", join(API_ROOT, "src", "routes", file), factory[2]);
    } else {
      const file = imports.get(target);
      if (file) registerFile(match[1] ?? "", file);
    }
  }
  return mounted;
}

test("every apps REST path the SDK requests is dual-mounted", () => {
  const mounted = mountedRoutes();

  const sdkPaths = new Set<string>();
  for (const source of SDK_SOURCES) {
    for (const path of extractApiPaths(read(REPO_ROOT, source))) {
      if (path.startsWith("/api/apps") || path.startsWith("/api/desktop/commands")) {
        sdkPaths.add(path);
      }
    }
  }
  for (const path of WEB_DIRECT_PATHS) sdkPaths.add(path);
  assert.ok(sdkPaths.size >= 20, `expected the full apps surface, found ${sdkPaths.size}`);

  const isMounted = (path: string) =>
    mounted.some((route) => segmentsMatch(route.split("/"), path.split("/")));

  const problems: string[] = [];
  for (const path of sdkPaths) {
    if (!isMounted(path)) problems.push(`canonical mount missing: ${path}`);
    const legacy = LEGACY_PREFIXES.find(([canonical]) => path.startsWith(canonical));
    if (legacy && !isMounted(path.replace(legacy[0], legacy[1]))) {
      problems.push(`legacy mount missing: ${path.replace(legacy[0], legacy[1])}`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    "apps REST is dual-mounted: both the canonical and legacy prefixes must keep serving every path",
  );
});
