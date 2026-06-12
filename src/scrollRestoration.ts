import { useEffect } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/**
 * Remembers scrollY per route. On forward nav we scroll back to top;
 * on a POP nav (back/forward) we restore the previously-saved position.
 * Listens to a passive scroll listener and stores values in a module Map.
 */
const positions = new Map<string, number>();

export function useScrollRestoration() {
  const { pathname } = useLocation();
  const navType = useNavigationType();

  useEffect(() => {
    // Restore (POP = back/forward) or reset (PUSH/REPLACE = new page).
    const saved = positions.get(pathname) ?? 0;
    const target = navType === "POP" ? saved : 0;
    // Wait a frame so the page has rendered before scrolling.
    const id = window.requestAnimationFrame(() => {
      window.scrollTo({ top: target, behavior: "auto" });
    });

    const onScroll = () => positions.set(pathname, window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.cancelAnimationFrame(id);
      // Capture once more on unmount in case the user scrolled and immediately navigated.
      positions.set(pathname, window.scrollY);
      window.removeEventListener("scroll", onScroll);
    };
  }, [pathname, navType]);
}
