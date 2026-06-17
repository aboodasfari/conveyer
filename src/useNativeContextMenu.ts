import { useEffect } from "react";

/**
 * Suppress the webview's native (browser) right-click context menu so the app
 * feels like a native desktop app rather than a web page — no "Back", "Reload",
 * "Inspect", etc.
 *
 * Exceptions, so we don't break genuinely useful behavior:
 *  - Editable elements (input, textarea, contenteditable) keep their menu so
 *    users can right-click to cut/copy/paste in fields.
 *  - In dev builds, holding Shift while right-clicking still shows the menu, so
 *    we can reach the inspector during development.
 */
export function useNativeContextMenu() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (import.meta.env.DEV && e.shiftKey) return;

      const target = e.target as HTMLElement | null;
      const editable = target?.closest(
        'input, textarea, [contenteditable=""], [contenteditable="true"]',
      );
      if (editable) return;

      e.preventDefault();
    };

    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
}
