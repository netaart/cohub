import type { GenerationModelDeclaration, GenerationOperationSpec } from "@neta-art/generation";

type PublicDeclaration = Omit<GenerationModelDeclaration, "adapter">;

export type GenerationOperation = GenerationOperationSpec & { name: string };

/** The functions a model with `operations` offers, in the order its `operation` parameter lists them. */
export function generationOperations(model: Pick<PublicDeclaration, "operations" | "parameters">): GenerationOperation[] {
  const operations = model.operations;
  if (!operations) return [];
  const spec = model.parameters?.operation;
  const order = spec?.type === "string" && spec.enum ? spec.enum : Object.keys(operations);
  return order.flatMap((name) => (Object.hasOwn(operations, name) ? [{ name, ...operations[name] }] : []));
}

/** The operation `parameters.operation` selects, falling back to the declared default. */
export function selectedGenerationOperation(
  model: Pick<PublicDeclaration, "operations" | "parameters">,
  parameters: Readonly<Record<string, unknown>>,
): GenerationOperation | null {
  const name = parameters.operation ?? model.parameters?.operation?.default;
  return generationOperations(model).find((operation) => operation.name === name) ?? null;
}

/**
 * The declaration a request is checked against: a model's content inputs and parameters plus those of the
 * operation `parameters.operation` selects, without `operations`. A model whose operation is not selected yet is
 * returned unchanged, so the caller reports the missing `operation` parameter.
 */
export function resolveGenerationOperation(
  model: PublicDeclaration,
  parameters: Readonly<Record<string, unknown>>,
): PublicDeclaration {
  const operation = selectedGenerationOperation(model, parameters);
  if (!operation) return model;
  const { operations: _operations, ...declaration } = model;
  return {
    ...declaration,
    content: { input: [...declaration.content.input, ...(operation.content?.input ?? [])] },
    parameters: { ...declaration.parameters, ...operation.parameters },
  };
}
