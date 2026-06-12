import { useEffect } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

const positions = new Map<string, number>();

/**
 * Saves scrollY per pathname. On POP nav (back/forward) we restore that
 * scroll position; on PUSH/REPLACE we reset to top.
 *
 * Because pages load their data async, the document is usually too short
 * to scroll to the saved position immediately. We therefore re-apply on
 * every layout change for ~1.5s, and bail out as soon as the user
 * deliberately scrolls (so we don't fight them).
 */
export function useScrollRestoration() {
  const { pathname } = useLocation();
  const navType = useNavigationType();

  useEffect(() => {
    const saved = positions.get(pathname) ?? 0;
    const target = navType === "POP" ? saved : 0;

    let cancelled = false;
    let userMoved = false;
    let lastProgScroll = -1;

    const apply = () => {
      if (cancelled || userMoved) return;
      // Only scroll if we're not already there (avoids unnecessary work).
      if (Math.abs(window.scrollY - target) <= 2) return;
      lastProgScroll = target;
      window.scrollTo({ top: target, behavior: "auto" });
    };

    // Distinguish programmatic scrolls from human ones.
    const onScroll = () => {
      // If this scroll is the result of our own scrollTo, ignore it.
      if (lastProgScroll !== -1 && Math.abs(window.scrollY - lastProgScroll) <= 2) {
        lastProgScroll = -1;
        return;
      }
      positions.set(pathname, window.scrollY);
    };
    const markUser = () => { userMoved = true; };

    // Initial apply (sync). Then retry as async content fills in.
    apply();
    let ro: ResizeObserver | null = null;
    if (target > 0) {
      ro = new ResizeObserver(() => apply());
      ro.observe(document.body);
    }
    // Hard stop after 1.5s so we don't fight the user later.
    const stopTimer = window.setTimeout(() => {
      cancelled = true;
      ro?.disconnect();
    }, 1500);

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", markUser, { passive: true });
    window.addEventListener("touchstart", markUser, { passive: true });
    window.addEventListener("keydown", markUser);

    return () => {
      cancelled = true;
      ro?.disconnect();
      window.clearTimeout(stopTimer);
      // Final capture so a rapid back-forward keeps the latest scrollY.
      positions.set(pathname, window.scrollY);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", markUser);
      window.removeEventListener("touchstart", markUser);
      window.removeEventListener("keydown", markUser);
    };
  }, [pathname, navType]);
}
