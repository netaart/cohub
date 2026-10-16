import type { GenerationModelDeclaration } from "@neta-art/generation";

type PublicDeclaration = Omit<GenerationModelDeclaration, "adapter">;

/**
 * Returns the declaration a request is checked against when the model has operations: its content inputs and
 * parameters plus those of the operation that `parameters.operation` selects, without the `operations` key. A model
 * whose operation is not selected yet is returned unchanged, so the caller reports the missing `operation` parameter.
 */
export function resolveGenerationOperation(
  model: PublicDeclaration,
  parameters: Readonly<Record<string, unknown>>,
): PublicDeclaration {
  const { operations, ...declaration } = model;
  if (!operations) return model;
  const name = parameters.operation ?? model.parameters?.operation?.default;
  const operation = typeof name === "string" && Object.hasOwn(operations, name) ? operations[name] : undefined;
  if (!operation) return model;
  return {
    ...declaration,
    content: { input: [...declaration.content.input, ...(operation.content?.input ?? [])] },
    parameters: { ...declaration.parameters, ...operation.parameters },
  };
}
