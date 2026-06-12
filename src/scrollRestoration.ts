import { useEffect } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

const positions = new Map<string, number>();

/**
 * Per-route scroll restoration that survives async content loads.
 *
 * Save heuristic: only save scrollY if the user has fired a real input
 * event (wheel/touch/key/mousedown) in the last 200 ms. This avoids
 * capturing the browser's automatic clamping when navigating from a tall
 * page to a short one — that clamp also fires `scroll`, but it happens
 * synchronously during the render cycle, long after any wheel event.
 *
 * Restore: re-apply via ResizeObserver as the page grows, bail out the
 * moment the user genuinely interacts. 2 s hard timeout.
 */
export function useScrollRestoration() {
  const { pathname } = useLocation();
  const navType = useNavigationType();

  useEffect(() => {
    const target = navType === "POP" ? (positions.get(pathname) ?? 0) : 0;

    let cancelled = false;
    let userMoved = false;
    let lastInteractAt = 0;

    const apply = () => {
      if (cancelled || userMoved) return;
      if (Math.abs(window.scrollY - target) <= 2) return;
      window.scrollTo({ top: target, behavior: "auto" });
    };

    const markUser = () => {
      lastInteractAt = Date.now();
      userMoved = true;
    };
    const onScroll = () => {
      // Only treat as user-initiated if a real input event happened recently.
      // 200 ms covers wheel + momentum smoothly, but excludes the clamping
      // that fires later during a route transition.
      if (Date.now() - lastInteractAt > 200) return;
      positions.set(pathname, window.scrollY);
    };

    apply();
    const ro = new ResizeObserver(() => apply());
    ro.observe(document.body);
    const stopTimer = window.setTimeout(() => {
      cancelled = true;
      ro.disconnect();
    }, 2000);

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", markUser, { passive: true });
    window.addEventListener("touchmove", markUser, { passive: true });
    window.addEventListener("keydown", markUser);
    window.addEventListener("mousedown", markUser);

    return () => {
      cancelled = true;
      ro.disconnect();
      window.clearTimeout(stopTimer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", markUser);
      window.removeEventListener("touchmove", markUser);
      window.removeEventListener("keydown", markUser);
      window.removeEventListener("mousedown", markUser);
    };
  }, [pathname, navType]);
}
