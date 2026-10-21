import type { GenerationModelDeclaration, GenerationOperationSpec } from "@neta-art/generation";

type PublicDeclaration = Omit<GenerationModelDeclaration, "adapter">;
export type GenerationOperation = GenerationOperationSpec & { name: string };

export function generationOperations(model: Pick<PublicDeclaration, "operations" | "parameters">): GenerationOperation[] {
  const operations = model.operations;
  if (!operations) return [];
  const spec = model.parameters?.operation;
  const order = spec?.type === "string" && spec.enum ? spec.enum : Object.keys(operations);
  return order.flatMap((name) => Object.hasOwn(operations, name) ? [{ name, ...operations[name] }] : []);
}
