import { useEffect, useRef } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { Phase, TaskSummary } from "./types";

/**
 * Watches all runs for phase-status transitions and fires a native OS
 * notification when something needs the user's attention (a phase enters
 * `waiting` for approval, or fails) and the app is not currently focused.
 *
 * Mounted once at the app shell. Cheap: re-fetches the task list whenever
 * the backend emits `run_updated`, diffs against the previous snapshot of
 * phase statuses by id.
 *
 * Click on a notification → focuses the window and (where Tauri supports
 * it) navigates to the task. The plugin doesn't expose click callbacks on
 * macOS reliably, so we just focus and rely on the user.
 */
export function useRunNotifications() {
  const lastStatusByPhase = useRef<Map<string, string>>(new Map());
  const taskTitleById = useRef<Map<string, string>>(new Map());
  const seeded = useRef(false);
  const permission = useRef<boolean | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          const res = await requestPermission();
          granted = res === "granted";
        }
        permission.current = granted;
      } catch {
        permission.current = false;
      }
    })();
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    const refresh = async (announce: boolean) => {
      try {
        const tasks = await api.tasksList();
        // Build a per-task title lookup so the notification body is useful.
        for (const t of tasks) taskTitleById.current.set(t.id, t.title);

        // We need phase status, but tasksList only carries the run summary.
        // Pull full run details for tasks that have an active or recently-
        // changed run. Cheap enough for the typical handful of in-flight tasks.
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
      if (!permission.current) return;

      // Only notify on *transitions into* states the user cares about,
      // and only when the window doesn't already have focus (no point
      // ringing a bell for someone staring at the screen).
      const becameWaiting = phase.status === "waiting" && prev !== "waiting";
      const becameFailed = phase.status === "failed" && prev !== "failed";
      if (!becameWaiting && !becameFailed) return;
      if (document.hasFocus()) return;

      const phaseLabel = labelFor(phase.kind);
      const title = becameWaiting
        ? `${phaseLabel} ready for review`
        : `${phaseLabel} failed`;
      const body = becameWaiting
        ? `“${task.title}” is waiting for your approval.`
        : `“${task.title}” stopped during ${phaseLabel.toLowerCase()}.`;
      try {
        sendNotification({ title, body });
      } catch {
        // Plugin not available or denied — silently skip.
      }
    };

    void (async () => {
      // Seed the snapshot without firing for current state, so we only
      // notify on changes that happen *after* the app loads.
      await refresh(false);
      seeded.current = true;
      unlisten = await listen("run_updated", () => {
        if (cancelled) return;
        void refresh(true);
      });
      if (cancelled) unlisten();
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
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
