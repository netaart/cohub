import type { Fetch, HttpTransport } from "../transport.js";
import type {
  GlobalSearchResponse,
  GlobalSearchType,
  PaletteOverviewResponse,
} from "../types.js";

export class SearchApi {
  constructor(private readonly transport: HttpTransport) {}

  query(
    input: {
      q: string;
      limit?: number;
      types?: GlobalSearchType[];
      spaceId?: string;
      labelRef?: string;
    },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams({ q: input.q });
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    for (const type of input.types ?? []) params.append("type", type);
    if (input.spaceId) params.set("spaceId", input.spaceId);
    if (input.labelRef) params.set("labelRef", input.labelRef);
    return this.transport.request<GlobalSearchResponse>(`/api/search?${params.toString()}`, {
      fetch: customFetch,
    });
  }

  /** Default (empty-query) command palette data: viewer-relative space signals. */
  overview(
    input?: {
      spaceLimit?: number;
      recentSpaces?: { id: string; timestamp: number }[];
      /** @deprecated Use `recentSpaces`; ids without a time count as just visited. */
      recentSpaceIds?: string[];
    },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams();
    if (input?.spaceLimit !== undefined) params.set("spaceLimit", String(input.spaceLimit));
    for (const recent of input?.recentSpaces ?? []) {
      params.append("recentSpaceId", recent.id);
      params.append("recentSpaceAt", new Date(recent.timestamp).toISOString());
    }
    for (const spaceId of input?.recentSpaceIds ?? [])
      params.append("recentSpaceId", spaceId);
    const query = params.toString();
    return this.transport.request<PaletteOverviewResponse>(
      `/api/palette/overview${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }
}
