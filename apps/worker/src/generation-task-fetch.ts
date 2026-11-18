const DEFAULT_GENERATION_BASE_URL = "https://router.neta.art";

export function createGenerationTaskFetch(
  taskRunId: string,
  {
    baseUrl = DEFAULT_GENERATION_BASE_URL,
    fetchFn = globalThis.fetch,
    onGatewayRequest,
  }: { baseUrl?: string; fetchFn?: typeof fetch; onGatewayRequest?: () => void } = {},
): typeof fetch {
  const gateway = new URL(baseUrl);
  const basePath = gateway.pathname.replace(/\/+$/, "");

  return (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input));
    if (
      url.origin !== gateway.origin ||
      (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
    ) {
      return fetchFn(input, init);
    }

    onGatewayRequest?.();
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.set("X-Cohub-Task-Id", taskRunId);
    const redirect = (init?.redirect ?? request?.redirect) === "manual" ? "manual" : "error";
    return fetchFn(input, { ...init, headers, redirect });
  };
}
