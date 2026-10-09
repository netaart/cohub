export type ToastTone = "neutral" | "danger";

export type ToastEntry = {
  key: string;
  title: string;
  message?: string;
  tone: ToastTone;
};

/**
 * Newest toast is at index 0 and is the only interactive one; older toasts stack behind it.
 * Kept small so the stack never covers the composer or a sheet footer.
 */
export const MAX_VISIBLE_TOASTS = 3;

export function pushToast(current: readonly ToastEntry[], next: ToastEntry): ToastEntry[] {
  const withoutDuplicateKey = current.filter((entry) => entry.key !== next.key);
  return [next, ...withoutDuplicateKey].slice(0, MAX_VISIBLE_TOASTS);
}

export function dismissToast(current: readonly ToastEntry[], key: string): ToastEntry[] {
  return current.filter((entry) => entry.key !== key);
}
