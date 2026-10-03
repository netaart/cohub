import { HttpError, type HttpTransport, type Fetch } from "../transport.js";
import type { LabelAssignmentRecord, LabelListItem, LabelResourceType, MeResponse, SessionRecord, SpaceRecord, UserActivityQuery, UserActivityResponse, UserProfile, UserRulesResponse, UserSessionsResponse, UserSessionSourceKey } from "../types.js";

const usageDate = (value: string | Date) => value instanceof Date ? value.toISOString() : value;

export class UserApi {
  readonly labels: UserLabelsApi;

  constructor(
    private readonly transport: HttpTransport,
    private readonly transportBaseUrl: string,
    private readonly setStoredAuthToken?: (token: string) => void,
    private readonly clearStoredAuthToken?: () => void,
  ) {
    this.labels = new UserLabelsApi(transport);
  }

  getMe(
    options?: Fetch | { fetch?: Fetch; skipUnauthorizedHandler?: boolean },
  ) {
    const init =
      typeof options === "function" ? { fetch: options } : options;
    return this.transport.request<MeResponse>("/api/me", init);
  }

  updateProfile(input: { displayName?: string; avatarUrl?: string | null; username?: string | null }) {
    return this.transport.request<{ profile: UserProfile }>("/api/me/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  getRules(customFetch?: Fetch) {
    return this.transport.request<UserRulesResponse>("/api/me/rules", {
      method: "GET",
      fetch: customFetch,
    });
  }

  listSessions(optionsOrFetch?: { limit?: number; cursor?: string | null; source?: readonly UserSessionSourceKey[] | null } | Fetch, customFetch?: Fetch) {
    const options = typeof optionsOrFetch === "function" ? undefined : optionsOrFetch;
    const fetch = typeof optionsOrFetch === "function" ? optionsOrFetch : customFetch;
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    if (options?.source?.length) params.set("source", options.source.join(","));
    const query = params.toString();
    return this.transport.request<UserSessionsResponse>(
      `/api/me/sessions${query ? `?${query}` : ""}`,
      { fetch },
    );
  }

  getSession(sessionId: string, customFetch?: Fetch) {
    return this.transport.request<{ space: SpaceRecord; session: SessionRecord }>(
      `/api/sessions/${sessionId}`,
      { fetch: customFetch },
    );
  }

  getActivity(options: UserActivityQuery = {}, customFetch?: Fetch) {
    const params = new URLSearchParams();
    if (options.days !== undefined) params.set("days", String(options.days));
    if (options.from !== undefined) params.set("from", usageDate(options.from));
    if (options.to !== undefined) params.set("to", usageDate(options.to));
    const query = params.toString();
    return this.transport.request<UserActivityResponse>(
      `/api/me/activity${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  async setAuthToken(token: string) {
    const trimmedToken = token.trim();
    const response = await fetch(
      this.transportBaseUrl ? `${this.transportBaseUrl}/api/me` : "/api/me",
      {
        headers: {
          Authorization: `Bearer ${trimmedToken}`,
        },
      },
    );

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => response.statusText);
      const message =
        typeof body === "string" ? body : JSON.stringify(body ?? null);
      throw new HttpError(message || response.statusText, response.status, body);
    }

    this.setStoredAuthToken?.(trimmedToken);
    return response.json();
  }

  async clearAuthToken() {
    this.clearStoredAuthToken?.();
    return null;
  }
}

/** User-scoped labels — same label/assignment model as space labels, but private to the viewer. */
export class UserLabelsApi {
  constructor(private readonly transport: HttpTransport) {}

  list() {
    return this.transport.request<{ labels: LabelListItem[] }>("/api/me/labels");
  }

  create(labelRef: string) {
    return this.transport.request<{ labels: LabelListItem[] }>("/api/me/labels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ labelRef }) });
  }

  resolve(labelRefs: string[]) {
    return this.transport.request<{ labels: LabelListItem[] }>("/api/me/labels/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ labelRefs }) });
  }

  update(labelRef: string, input: { name?: string; parentRef?: string | null; rank?: number }) {
    return this.transport.request<{ label: LabelListItem }>("/api/me/labels/by-ref", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ labelRef, ...input }) });
  }

  delete(labelRef: string) {
    return this.transport.request<{ ok: true }>(`/api/me/labels/by-ref?${new URLSearchParams({ ref: labelRef })}`, { method: "DELETE" });
  }

  reorder(labelRefs: string[]) {
    return this.transport.request<{ labels: LabelListItem[] }>("/api/me/labels/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ labelRefs }) });
  }

  patchResources(resourceRefs: string[], input: { addLabelRefs?: string[]; removeLabelRefs?: string[] }) {
    return this.transport.request<{ resourceRefs: string[]; affectedLabelIds: string[] }>("/api/me/resources/space/labels/batch", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resourceRefs, ...input }) });
  }

  getResourceLabels(resourceType: LabelResourceType, resourceRef: string) {
    const params = new URLSearchParams({ resourceRef });
    return this.transport.request<{ assignments: LabelAssignmentRecord[] }>(
      `/api/me/resources/${resourceType}/labels?${params.toString()}`,
    );
  }

  patchResourceLabels(resourceType: LabelResourceType, resourceRef: string, input: { addLabelRefs?: string[]; removeLabelRefs?: string[] }) {
    const params = new URLSearchParams({ resourceRef });
    return this.transport.request<{ assignments: LabelAssignmentRecord[] }>(
      `/api/me/resources/${resourceType}/labels?${params.toString()}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }
}
