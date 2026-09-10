// Resolves the `@/` path alias and extensionless relative TypeScript imports
// for Node-based checks that load app modules directly (Node does not read
// tsconfig paths and requires explicit extensions).
const EXTENSIONS = [".ts", ".tsx"];

async function resolveWithExtension(base, context, nextResolve) {
  for (const extension of EXTENSIONS) {
    try {
      return await nextResolve(`${base}${extension}`, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`Cannot resolve ${base} with .ts or .tsx`);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = new URL(`../${specifier.slice(2)}`, import.meta.url).href;
    return resolveWithExtension(base, context, nextResolve);
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.[a-zA-Z0-9]+$/.test(specifier)
  ) {
    return resolveWithExtension(specifier, context, nextResolve);
  }
  return nextResolve(specifier, context);
}
