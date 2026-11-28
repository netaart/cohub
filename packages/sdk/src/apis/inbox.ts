import type { InboxListResponse, InboxReadTarget, InboxSummary } from "@cohub/protocol";
import type { HttpTransport } from "../transport.js";

export class InboxApi {
  constructor(private readonly transport: HttpTransport) {}

  list(options: { unread?: boolean; cursor?: string | null; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (options.unread) params.set("unread", "true");
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.transport.request<InboxListResponse>(`/api/me/inbox${query ? `?${query}` : ""}`);
  }

  summary() {
    return this.transport.request<InboxSummary>("/api/me/inbox/summary");
  }

  markRead(target: InboxReadTarget) {
    return this.transport.request<{ changed: number; summary: InboxSummary }>("/api/me/inbox/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target),
    });
  }
}
