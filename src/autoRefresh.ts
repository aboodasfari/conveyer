import { useEffect, useState } from "react";
import { api } from "./api";

const KEY = "refresh_interval_min";
const DEFAULT = 30;

export async function loadRefreshInterval(): Promise<number> {
  try {
    const v = await api.settingGet(KEY);
    if (!v) return DEFAULT;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export async function saveRefreshInterval(min: number): Promise<void> {
  await api.settingSet(KEY, String(min));
  // Notify any listeners (e.g. the AutoRefresh hook) that the interval changed.
  window.dispatchEvent(new CustomEvent("conveyer:refresh-interval-changed"));
}

/**
 * Polls all enabled sources every `intervalMin` minutes by calling
 * tasks_refresh. Reads the interval from settings; reacts to a custom event
 * fired by `saveRefreshInterval` so updates take effect immediately.
 */
export function useAutoRefresh(onRefreshed?: () => void) {
  const [interval, setInterval] = useState<number>(DEFAULT);

  useEffect(() => {
    let cancelled = false;
    const apply = async () => {
      const i = await loadRefreshInterval();
      if (!cancelled) setInterval(i);
    };
    void apply();
    const onChange = () => { void apply(); };
    window.addEventListener("conveyer:refresh-interval-changed", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("conveyer:refresh-interval-changed", onChange);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const sources = await api.sourcesList();
        for (const s of sources) {
          if (s.enabled) await api.tasksRefresh(s.id);
        }
        if (onRefreshed) onRefreshed();
      } catch {
        // swallow — the dashboard will still surface manual-refresh errors
      }
    };
    const id = window.setInterval(tick, interval * 60 * 1000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [interval, onRefreshed]);
}
