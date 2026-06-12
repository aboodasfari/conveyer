import { useEffect } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

const positions = new Map<string, number>();

/**
 * Per-route scroll restoration that survives async content loads.
 *
 * The tricky part: when we re-mount a route and try to `scrollTo(target)`
 * before the page's data has loaded, the body is too short and the scroll
 * is capped — but the resulting (capped) `scroll` event would clobber the
 * saved position if we treated it as user-initiated. We avoid that by only
 * saving the scroll position **after the user has interacted** with the
 * page (wheel / touch / keydown). All programmatic / restore scrolls are
 * ignored for save purposes.
 */
export function useScrollRestoration() {
  const { pathname } = useLocation();
  const navType = useNavigationType();

  useEffect(() => {
    const target = navType === "POP" ? (positions.get(pathname) ?? 0) : 0;

    let cancelled = false;
    let userMoved = false;

    const apply = () => {
      if (cancelled || userMoved) return;
      if (Math.abs(window.scrollY - target) <= 2) return;
      window.scrollTo({ top: target, behavior: "auto" });
    };

    // Save position only once the user has actually interacted with the
    // page. Programmatic and restore-triggered scrolls don't touch the map.
    const markUser = () => { userMoved = true; };
    const onScroll = () => {
      if (!userMoved) return;
      positions.set(pathname, window.scrollY);
    };

    // Initial attempt + observer-based retries while the page grows.
    apply();
    const ro = new ResizeObserver(() => apply());
    ro.observe(document.body);
    const stopTimer = window.setTimeout(() => {
      cancelled = true;
      ro.disconnect();
    }, 2000);

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", markUser, { passive: true });
    window.addEventListener("touchstart", markUser, { passive: true });
    window.addEventListener("keydown", markUser);

    return () => {
      cancelled = true;
      ro.disconnect();
      window.clearTimeout(stopTimer);
      // Capture the user's final scrollY on unmount, but only if they
      // actually moved — otherwise we'd overwrite a real saved position
      // with whatever the restore landed on.
      if (userMoved) positions.set(pathname, window.scrollY);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", markUser);
      window.removeEventListener("touchstart", markUser);
      window.removeEventListener("keydown", markUser);
    };
  }, [pathname, navType]);
}
