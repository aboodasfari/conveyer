import { useEffect, useRef } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { Phase, TaskSummary } from "./types";const PREF_KEYS = {
  enabled: "notif_enabled",
  waiting: "notif_waiting",
  failed: "notif_failed",
  newTask: "notif_new_task",
  taskFinished: "notif_task_finished",
} as const;

export type NotifKind = "waiting" | "failed" | "newTask" | "taskFinished";

const DEFAULT_PREFS: Record<keyof typeof PREF_KEYS, boolean> = {
  enabled: true,
  waiting: true,
  failed: true,
  newTask: true,
  taskFinished: true,
};

/** Read a single boolean setting, treating any non-"0"/"false" value (or
 *  unset) as the supplied default. Centralised here so the same shape is
 *  used everywhere we touch notification prefs. */
async function readPref(key: string, fallback: boolean): Promise<boolean> {
  try {
    const v = await api.settingGet(key);
    if (v === null || v === undefined) return fallback;
    return v !== "0" && v.toLowerCase() !== "false";
  } catch {
    return fallback;
  }
}

export async function loadNotifPrefs(): Promise<Record<keyof typeof PREF_KEYS, boolean>> {
  const entries = await Promise.all(
    (Object.entries(PREF_KEYS) as [keyof typeof PREF_KEYS, string][]).map(
      async ([k, key]) => [k, await readPref(key, DEFAULT_PREFS[k])] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<keyof typeof PREF_KEYS, boolean>;
}

export async function setNotifPref(kind: keyof typeof PREF_KEYS, value: boolean): Promise<void> {
  await api.settingSet(PREF_KEYS[kind], value ? "1" : "0");
  window.dispatchEvent(new CustomEvent("conveyer:notif-prefs-changed"));
}

/**
 * Watches the backend for things worth nudging the user about and fires a
 * native OS notification — only while the window isn't focused, and only
 * for the kinds the user has enabled in Settings.
 *
 * Mounted once at the app shell. Triggers:
 *  - phase enters `waiting` (needs approval)
 *  - phase enters `failed`
 *  - a new task appears in the dashboard (source refresh discovered it)
 *  - a task finishes (latest run status transitions to `done`)
 *
 * Initial snapshots are seeded silently so we don't spam at startup.
 */
export function useRunNotifications() {
  const lastStatusByPhase = useRef<Map<string, string>>(new Map());
  const lastRunStatusByTask = useRef<Map<string, string | null>>(new Map());
  const knownTaskIds = useRef<Set<string>>(new Set());
  const permission = useRef<boolean | null>(null);
  // Tauri's window.isFocused is the source of truth on macOS; the DOM's
  // document.hasFocus() can lie when the WebView keeps internal focus
  // while the window itself is backgrounded.
  const windowFocused = useRef<boolean>(true);

  useEffect(() => {
    let unlistenFocus: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          const res = await requestPermission();
          granted = res === "granted";
        }
        permission.current = granted;
        // eslint-disable-next-line no-console
        console.info(`[notif] permission: ${granted ? "granted" : "denied"}`);
      } catch (e) {
        permission.current = false;
        // eslint-disable-next-line no-console
        console.warn("[notif] permission check failed:", e);
      }

      try {
        const win = getCurrentWindow();
        windowFocused.current = await win.isFocused();
        unlistenFocus = await win.onFocusChanged(({ payload: focused }) => {
          windowFocused.current = focused;
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[notif] focus tracking unavailable:", e);
      }

      if (cancelled && unlistenFocus) unlistenFocus();
    })();
    return () => {
      cancelled = true;
      if (unlistenFocus) unlistenFocus();
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let unlistenRefreshed: (() => void) | null = null;
    let cancelled = false;

    const maybeNotify = async (kind: NotifKind, title: string, body: string) => {
      if (!permission.current) {
        // eslint-disable-next-line no-console
        console.info(`[notif] skipped (${kind}): permission not granted`);
        return;
      }
      if (windowFocused.current) {
        // eslint-disable-next-line no-console
        console.info(`[notif] skipped (${kind}): window focused`);
        return;
      }
      const prefs = await loadNotifPrefs();
      if (!prefs.enabled) {
        // eslint-disable-next-line no-console
        console.info(`[notif] skipped (${kind}): master toggle off`);
        return;
      }
      if (!prefs[kind]) {
        // eslint-disable-next-line no-console
        console.info(`[notif] skipped (${kind}): ${kind} toggle off`);
        return;
      }
      try {
        sendNotification({ title, body });
        // eslint-disable-next-line no-console
        console.info(`[notif] fired (${kind}): ${title}`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[notif] send failed (${kind}):`, e);
      }
    };

    const refresh = async (announce: boolean) => {
      try {
        const [tasks, sources] = await Promise.all([
          api.tasksList(),
          api.sourcesList().catch(() => []),
        ]);
        const sourceNameById = new Map(sources.map((s) => [s.id, s.name]));

        // New-task detection runs over the full list (cheap; tasks have
        // stable ids). Seeded silently on the first pass.
        const ids = new Set(tasks.map((t) => t.id));
        if (announce) {
          for (const t of tasks) {
            if (!knownTaskIds.current.has(t.id)) {
              const sourceName = sourceNameById.get(t.source_id);
              const fromClause = sourceName
                ? `Discovered in ${sourceName}.`
                : t.source_id === "local"
                  ? "Created locally."
                  : "Newly discovered.";
              void maybeNotify("newTask", `New Task: ${t.title}`, fromClause);
            }
          }
        }
        knownTaskIds.current = ids;

        // Task-finished detection: latest run status transitioned to "done".
        // Tracked per-task; seeded silently on the first pass.
        for (const t of tasks) {
          const prev = lastRunStatusByTask.current.get(t.id);
          const curr = t.run_status ?? null;
          lastRunStatusByTask.current.set(t.id, curr);
          if (!announce) continue;
          if (curr === "done" && prev !== undefined && prev !== "done") {
            void maybeNotify(
              "taskFinished",
              `Task Finished: ${t.title}`,
              "All phases completed successfully.",
            );
          }
        }

        // Phase transitions need full run details. Pull only for tasks
        // with an active/changed run.
        const candidates = tasks.filter(
          (t) =>
            t.run_status === "running" ||
            t.run_status === "waiting" ||
            t.run_status === "failed",
        );
        for (const task of candidates) {
          const runs = await api.runsForTask(task.id).catch(() => []);
          const active = runs.find((r) =>
            ["running", "waiting", "failed"].includes(r.status),
          );
          if (!active) continue;
          const detail = await api.runGet(active.id).catch(() => null);
          if (!detail) continue;
          for (const p of detail.phases) {
            checkTransition(task, p, announce);
          }
        }
      } catch {
        // ignore — we'll catch the next event
      }
    };

    const checkTransition = (task: TaskSummary, phase: Phase, announce: boolean) => {
      const prev = lastStatusByPhase.current.get(phase.id);
      lastStatusByPhase.current.set(phase.id, phase.status);
      if (!announce) return;

      const becameWaiting = phase.status === "waiting" && prev !== "waiting";
      const becameFailed = phase.status === "failed" && prev !== "failed";
      if (!becameWaiting && !becameFailed) return;

      const phaseLabel = labelFor(phase.kind);
      const title = becameWaiting
        ? `${phaseLabel} ready for review`
        : `${phaseLabel} failed`;
      const body = becameWaiting
        ? `“${task.title}” is waiting for your approval.`
        : `“${task.title}” stopped during ${phaseLabel.toLowerCase()}.`;
      void maybeNotify(becameWaiting ? "waiting" : "failed", title, body);
    };

    void (async () => {
      // Seed the snapshots without firing for current state.
      await refresh(false);
      unlisten = await listen("run_updated", () => {
        if (cancelled) return;
        void refresh(true);
      });
      // Auto-refresh polling fires this — new tasks appear here.
      const handler = () => { if (!cancelled) void refresh(true); };
      window.addEventListener("conveyer:sources-refreshed", handler);
      unlistenRefreshed = () => window.removeEventListener("conveyer:sources-refreshed", handler);
      if (cancelled) {
        unlisten();
        unlistenRefreshed();
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (unlistenRefreshed) unlistenRefreshed();
    };
  }, []);
}

function labelFor(kind: string): string {
  switch (kind) {
    case "exploration": return "Exploration";
    case "planning": return "Planning";
    case "implementation": return "Implementation";
    case "review": return "Review";
    case "submit": return "Submit";
    default: return kind;
  }
}

/** Best-effort: bring the app to the foreground. Used as a fallback when
 *  the notification plugin doesn't deliver click events. */
export async function focusMainWindow() {
  try {
    const win = getCurrentWindow();
    await win.unminimize();
    await win.show();
    await win.setFocus();
  } catch {
    // ignore
  }
}
