import type { GenerationModelCategory, GenerationModelDeclaration } from "@neta-art/generation";

export type GenerationModelVisibility = Pick<GenerationModelDeclaration, "model" | "hidden">;
export type GenerationCategory = GenerationModelCategory;

const CATEGORY_ORDER: Record<GenerationCategory, true> = { image: true, video: true, audio: true, "3d": true, decision: true };

export const GENERATION_CATEGORIES = Object.keys(CATEGORY_ORDER) as readonly GenerationCategory[];

export type GenerationCategoryGroup<T> = {
  category: GenerationCategory | null;
  models: T[];
};

export function isGenerationModelHidden(model: GenerationModelVisibility): boolean {
  return model.hidden === true;
}

export function filterDiscoverableGenerationModels<T extends GenerationModelVisibility>(
  models: readonly T[],
  options: { includeModelIds?: Iterable<string> } = {},
): T[] {
  const includeModelIds = new Set(options.includeModelIds);
  return models.filter((model) => !isGenerationModelHidden(model) || includeModelIds.has(model.model));
}

export function generationModelCategory(model: { category?: string | null }): GenerationCategory | null {
  const category = model.category;
  return category && Object.hasOwn(CATEGORY_ORDER, category) ? (category as GenerationCategory) : null;
}

export function groupGenerationModelsByCategory<T extends { category?: string | null }>(
  models: readonly T[],
): GenerationCategoryGroup<T>[] {
  const groups = new Map<GenerationCategory | null, T[]>([...GENERATION_CATEGORIES, null].map((category) => [category, []]));
  for (const model of models) groups.get(generationModelCategory(model))?.push(model);
  return [...groups].flatMap(([category, items]) => (items.length > 0 ? [{ category, models: items }] : []));
}
