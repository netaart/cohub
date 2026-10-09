const MAX_ENTRY_CHARS = 256 * 1024;
const MAX_TOTAL_CHARS = 8 * 1024 * 1024;

type RevalidationEntry = { etag: string; body: string };

const entries = new Map<string, RevalidationEntry>();
let totalChars = 0;

const runtime = globalThis as typeof globalThis & {
  window?: unknown;
  process?: { versions?: { node?: string } };
};

// Browsers revalidate natively; a script-set If-None-Match would also need CORS.
export const revalidationEnabled = runtime.window === undefined && Boolean(runtime.process?.versions?.node);

function remove(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  totalChars -= entry.body.length;
}

export function readRevalidationEntry(key: string): RevalidationEntry | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

export function writeRevalidationEntry(key: string, etag: string | null, body: string) {
  remove(key);
  if (!etag || body.length > MAX_ENTRY_CHARS) return;
  entries.set(key, { etag, body });
  totalChars += body.length;
  for (const oldest of entries.keys()) {
    if (totalChars <= MAX_TOTAL_CHARS) break;
    remove(oldest);
  }
}
