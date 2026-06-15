import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * When the OS window regains focus, broadcast a refresh signal so pages
 * (Dashboard, TaskDetail, etc.) re-fetch immediately instead of waiting
 * for the next setInterval tick or queued event delivery.
 *
 * macOS WKWebView throttles JS timers and queues some events while a
 * window is hidden or in another Space; the backend keeps running fine,
 * but the UI looks stale until something pokes it. This is that poke.
 *
 * Mounted once at the app shell.
 */
export function useFocusRefresh() {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const win = getCurrentWindow();
        unlisten = await win.onFocusChanged(({ payload: focused }) => {
          if (!focused) return;
          window.dispatchEvent(new CustomEvent("conveyer:sources-refreshed"));
          // Also nudge components that key off run_updated.
          window.dispatchEvent(new CustomEvent("conveyer:focus-refresh"));
        });
      } catch {
        // Tauri focus API not available — fall back to silent no-op.
      }
      if (cancelled && unlisten) unlisten();
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
