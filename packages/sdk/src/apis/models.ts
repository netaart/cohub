import type { HttpTransport } from "../transport.js";
import type {
  ListGenerationModelsResponse,
  ModelCatalogEntry,
  ModelStatusResponse,
} from "../types.js";

export const MULTIMODAL_MODEL_TYPE = "multimodal";

export type ModelsCatalog = Record<string, ModelCatalogEntry[]>;

export class ModelsApi {
  constructor(private readonly transport: HttpTransport) {}

  async list(options: { spaceId?: string | null } = {}) {
    const spaceId = options.spaceId?.trim();
    const query = spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : "";
    return this.transport.request<ModelsCatalog>(
      `/api/models${query}`,
    );
  }

  async listMultimodal(): Promise<ListGenerationModelsResponse> {
    return this.transport.request<ListGenerationModelsResponse>(
      `/api/models?modelType=${MULTIMODAL_MODEL_TYPE}`,
    );
  }

  async status(): Promise<ModelStatusResponse> {
    return this.transport.request<ModelStatusResponse>("/api/models/status");
  }
}
