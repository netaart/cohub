import { resolve, sep } from "node:path";

export function assertInsideRoot(target: string, root: string, message = "Path outside workspace is not allowed.") {
  const normalizedTarget = resolve(target);
  const normalizedRoot = resolve(root);
  const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(rootWithSep)) return;
  throw new Error(message);
}
