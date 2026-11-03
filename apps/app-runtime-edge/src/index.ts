import devRuntime from "../dist/runtime-dev.js.txt";
import prodRuntime from "../dist/runtime-prod.js.txt";

const HOST = "works.cohub.live";
// Bump when the HTML injection contract changes; runtime bytes have their own ETag.
const INJECTION_VERSION = "1";

function environmentConfig(environment: "dev" | "prod") {
  const runtimePrefix = environment === "dev" ? "/__cohub_dev/" : "/__cohub/";
  return {
    environment,
    appPrefix: environment === "dev" ? "/dev/w/" : "/w/",
    runtimePrefix,
    runtimePath: `${runtimePrefix}runtime.js`,
    runtimeSource: environment === "dev" ? devRuntime : prodRuntime,
  };
}

type RuntimeConfig = ReturnType<typeof environmentConfig>;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function etagMatches(header: string | null, etag: string): boolean {
  return Boolean(header?.match(/(?:W\/)?"[^"]*"|\*/g)?.some((value) =>
    value === "*" || value.replace(/^W\//, "") === etag.replace(/^W\//, ""),
  ));
}

function hasNoTransform(headers: Headers): boolean {
  return /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(headers.get("Cache-Control") ?? "");
}

function isNavigation(request: Request): boolean {
  const destination = request.headers.get("Sec-Fetch-Dest");
  if (destination) return ["document", "iframe", "frame"].includes(destination);
  // Non-browser clients must explicitly request HTML; SDK/CLI downloads use */*.
  return (request.headers.get("Accept") ?? "").toLowerCase().includes("text/html");
}

function varyByNavigation(headers: Headers): void {
  const existing = headers.get("Vary");
  if (existing?.trim() === "*") return;
  const values = new Map((existing ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => [value.toLowerCase(), value]));
  values.set("accept", "Accept");
  values.set("sec-fetch-dest", "Sec-Fetch-Dest");
  headers.set("Vary", [...values.values()].join(", "));
}

function rawNotModified(request: Request, headers: Headers): boolean {
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch !== null) {
    if (ifNoneMatch.trim() === "*") return true;
    const etag = headers.get("ETag");
    return etag !== null && etagMatches(ifNoneMatch, etag);
  }
  const modified = headers.get("Last-Modified");
  const since = request.headers.get("If-Modified-Since");
  return modified !== null && since !== null && Date.parse(modified) <= Date.parse(since);
}

async function passThrough(request: Request, upstream: Response, headers: Headers, revalidate: boolean): Promise<Response> {
  if (revalidate && upstream.status === 200 && rawNotModified(request, headers)) {
    await upstream.body?.cancel();
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

async function serveRuntime(request: Request, config: RuntimeConfig): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
    });
  }
  const etag = `"${await digest(config.runtimeSource)}"`;
  const headers = new Headers({
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=900, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "X-Cohub-Runtime": `${config.environment}-bootstrap-${INJECTION_VERSION}`,
    ETag: etag,
  });
  if (etagMatches(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : config.runtimeSource, { headers });
}

function injectRuntime(upstream: Response, headers: Headers, config: RuntimeConfig, pageUrl: URL): Response {
  const runtimeUrl = `https://${HOST}${config.runtimePath}`;
  const script = `<script data-cohub-runtime="${config.environment}" data-cfasync="false" src="${runtimeUrl}" defer></script>`;
  let inserted = false;
  const insertBefore = (element: Element | EndTag): void => {
    if (inserted) return;
    element.before(script, { html: true });
    inserted = true;
  };
  // Track an authored base URL so relative author scripts are never misidentified.
  let baseUrl = pageUrl.href;
  let hasBase = false;
  const isRuntime = (element: Element): boolean => {
    const src = element.getAttribute("src");
    if (!src) return false;
    try {
      return new URL(src, baseUrl).href === runtimeUrl;
    } catch {
      return false;
    }
  };
  return new HTMLRewriter()
    .on("head", { element(element) { element.onEndTag(insertBefore); } })
    .on("base[href]", {
      element(element) {
        if (hasBase) return;
        hasBase = true;
        try { baseUrl = new URL(element.getAttribute("href") ?? "", pageUrl).href; } catch { /* Preserve invalid author markup. */ }
      },
    })
    .on("head > script", {
      element(element) {
        if (!isRuntime(element) && (element.getAttribute("type")?.trim().toLowerCase() === "module" || element.hasAttribute("defer"))) {
          insertBefore(element);
        }
      },
    })
    .on("script", {
      element(element) {
        if (!isRuntime(element)) return;
        if (inserted) element.remove();
        else inserted = true;
      },
    })
    .on("body", {
      element(element) {
        if (inserted) return;
        element.prepend(script, { html: true });
        inserted = true;
      },
    })
    .onDocument({ end(end) { if (!inserted) end.append(script, { html: true }); } })
    .transform(new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== HOST) return new Response("Not found", { status: 404 });
    if (env.COHUB_ENV !== "dev" && env.COHUB_ENV !== "prod") {
      return new Response("Runtime configuration unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const config = environmentConfig(env.COHUB_ENV);
    if (url.pathname === config.runtimePath) return serveRuntime(request, config);
    if (url.pathname.startsWith(config.runtimePrefix)) {
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (!url.pathname.startsWith(config.appPrefix)) return fetch(request);

    const navigation = (request.method === "GET" || request.method === "HEAD") && isNavigation(request) && !request.headers.has("Range") && !hasNoTransform(request.headers);
    let upstreamRequest = request;
    if (navigation) {
      // Original artifact validators cannot validate the injected representation.
      upstreamRequest = new Request(request, { method: "GET", redirect: "manual" });
      upstreamRequest.headers.delete("If-None-Match");
      upstreamRequest.headers.delete("If-Modified-Since");
    }
    const upstream = await fetch(upstreamRequest, navigation ? undefined : { cf: { cacheEverything: true } });
    const headers = new Headers(upstream.headers);
    const html = (headers.get("Content-Type") ?? "").split(";", 1)[0]?.trim().toLowerCase() === "text/html";
    if (html) varyByNavigation(headers);
    if (!navigation || !html || upstream.status !== 200 || /\battachment\b/i.test(headers.get("Content-Disposition") ?? "") || hasNoTransform(headers)) {
      return passThrough(request, upstream, headers, navigation);
    }

    const validator = headers.get("ETag") ?? headers.get("x-amz-meta-sha256") ?? headers.get("x-oss-meta-sha256") ?? (headers.get("Last-Modified") ? `${headers.get("Last-Modified")}:${headers.get("Content-Length") ?? ""}` : null);
    for (const name of ["Content-Length", "Content-MD5", "Digest", "Content-Digest", "Repr-Digest", "Accept-Ranges", "Last-Modified", "ETag", "x-oss-hash-crc64ecma", "x-amz-meta-sha256", "x-oss-meta-sha256"]) headers.delete(name);
    headers.set("X-Cohub-Runtime", `${config.environment}-bootstrap-${INJECTION_VERSION}`);
    if (validator) {
      const etag = `W/"${await digest(`${url.pathname}:${validator}:${config.environment}:${INJECTION_VERSION}`)}"`;
      headers.set("ETag", etag);
      if (etagMatches(request.headers.get("If-None-Match"), etag)) {
        await upstream.body?.cancel();
        return new Response(null, { status: 304, headers });
      }
    }
    if (request.method === "HEAD") {
      await upstream.body?.cancel();
      return new Response(null, { headers });
    }
    return injectRuntime(upstream, headers, config, url);
  },
} satisfies ExportedHandler<Env>;
