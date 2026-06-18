/**
 * Tiny in-process pub/sub for "a setting changed". Anything that reads global
 * settings can subscribe to refresh its state when settings are mutated by
 * another part of the app (notably the Settings page), so derived UI like the
 * per-task Run settings card stays in sync with the global default.
 *
 * The api wrapper around `setting_set` (see `api.ts`) calls notify() after a
 * successful write.
 */

type Listener = (key: string) => void;
const listeners = new Set<Listener>();

export function onSettingChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifySettingChanged(key: string): void {
  for (const fn of listeners) fn(key);
}
