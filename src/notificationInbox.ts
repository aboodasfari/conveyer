import { useEffect, useSyncExternalStore } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api } from "./api";
import {
  NotifKind,
  NotifTransition,
  subscribeNotifTransitions,
} from "./runNotifications";

/**
 * A single item shown in the in-app notifications popover. Items are
 * ephemeral (in-memory only) — they don't survive an app restart, but
 * `seedFromCurrentState` re-derives the state-driven kinds on launch.
 */
export interface InboxItem {
  id: string;
  kind: NotifKind;
  taskId: string;
  phaseId?: string;
  title: string;
  body: string;
  ts: number;
}

const INAPP_PREF_KEYS = {
  enabled: "inapp_notif_enabled",
  waiting: "inapp_notif_waiting",
  failed: "inapp_notif_failed",
  newTask: "inapp_notif_new_task",
  taskFinished: "inapp_notif_task_finished",
} as const;

export type InAppNotifPrefKey = keyof typeof INAPP_PREF_KEYS;

const DEFAULT_INAPP_PREFS: Record<InAppNotifPrefKey, boolean> = {
  enabled: true,
  waiting: true,
  failed: true,
  newTask: true,
  taskFinished: true,
};

async function readBoolPref(key: string, fallback: boolean): Promise<boolean> {
  try {
    const v = await api.settingGet(key);
    if (v === null || v === undefined) return fallback;
    return v !== "0" && v.toLowerCase() !== "false";
  } catch {
    return fallback;
  }
}

export async function loadInAppNotifPrefs(): Promise<Record<InAppNotifPrefKey, boolean>> {
  const entries = await Promise.all(
    (Object.entries(INAPP_PREF_KEYS) as [InAppNotifPrefKey, string][]).map(
      async ([k, key]) => [k, await readBoolPref(key, DEFAULT_INAPP_PREFS[k])] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<InAppNotifPrefKey, boolean>;
}

export async function setInAppNotifPref(kind: InAppNotifPrefKey, value: boolean): Promise<void> {
  await api.settingSet(INAPP_PREF_KEYS[kind], value ? "1" : "0");
  window.dispatchEvent(new CustomEvent("conveyer:inapp-notif-prefs-changed"));
}

/* ------------------------------ Store ------------------------------ */

let items: InboxItem[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): InboxItem[] {
  return items;
}

function setItems(next: InboxItem[]) {
  if (next === items) return;
  items = next;
  notify();
}

/** Newest-first, most recent activity at the top. */
function sortItems(arr: InboxItem[]): InboxItem[] {
  return [...arr].sort((a, b) => b.ts - a.ts);
}

function makeItemId(t: { kind: NotifKind; taskId: string; phaseId?: string; ts: number }): string {
  // Phase-driven items dedupe per phase so a re-fired "waiting" doesn't
  // pile up; task-driven items use the timestamp so successive
  // "newTask"/"taskFinished" remain distinct rows.
  if (t.phaseId) return `${t.kind}:${t.taskId}:${t.phaseId}`;
  return `${t.kind}:${t.taskId}:${t.ts}`;
}

function pushItem(item: InboxItem) {
  const next = items.filter((it) => it.id !== item.id);
  next.push(item);
  setItems(sortItems(next));
}

export function dismissItem(id: string): void {
  const next = items.filter((it) => it.id !== id);
  if (next.length === items.length) return;
  setItems(next);
}

/**
 * Remove inbox items belonging to a task. If `kinds` is omitted, drops
 * all of the task's items; otherwise only the listed kinds.
 */
export function dismissForTask(taskId: string, kinds?: NotifKind[]): void {
  const kindSet = kinds ? new Set<NotifKind>(kinds) : null;
  const next = items.filter((it) => {
    if (it.taskId !== taskId) return true;
    if (kindSet && !kindSet.has(it.kind)) return true;
    return false;
  });
  if (next.length === items.length) return;
  setItems(next);
}

export function clearAll(): void {
  if (items.length === 0) return;
  setItems([]);
}

/* ----------------------- Consumer hook ------------------------ */

export function useInboxItems(): InboxItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/* ----------------------- Backend reconciliation ------------------------ */

const ACTIVE_PHASE_STATUSES = new Set(["waiting", "failed", "needs_input"]);

interface CurrentState {
  taskIds: Set<string>;
  // Map<phaseId, phase status>
  phaseStatusById: Map<string, string>;
}

async function fetchCurrentState(): Promise<CurrentState> {
  const tasks = await api.tasksList().catch(() => [] as Awaited<ReturnType<typeof api.tasksList>>);
  const taskIds = new Set(tasks.map((t) => t.id));
  const phaseStatusById = new Map<string, string>();
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
    for (const p of detail.phases) phaseStatusById.set(p.id, p.status);
  }
  return { taskIds, phaseStatusById };
}

/**
 * Drop items whose underlying backend state has resolved:
 *  - waiting/failed/needs_input phase items disappear when the phase
 *    leaves that status (approved, rewound, restarted, etc.)
 *  - newTask/taskFinished items disappear if the task is gone.
 */
async function runAutoDismissPass(): Promise<void> {
  if (items.length === 0) return;
  const state = await fetchCurrentState();
  const next = items.filter((it) => {
    if (it.kind === "newTask" || it.kind === "taskFinished") {
      return state.taskIds.has(it.taskId);
    }
    // waiting / failed → require phase to still be in an active status.
    if (it.phaseId) {
      const status = state.phaseStatusById.get(it.phaseId);
      if (!status) return false;
      return ACTIVE_PHASE_STATUSES.has(status);
    }
    return true;
  });
  if (next.length !== items.length) setItems(next);
}

/**
 * On first mount, seed the inbox with currently-active phase items
 * (`waiting`/`failed`/`needs_input`) so the bell reflects the user's
 * outstanding queue at launch. Transient kinds (`newTask`/
 * `taskFinished`) are intentionally NOT replayed.
 */
async function seedFromCurrentState(): Promise<void> {
  try {
    const tasks = await api.tasksList();
    const now = Date.now();
    const seeded: InboxItem[] = [];
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
        if (!ACTIVE_PHASE_STATUSES.has(p.status)) continue;
        const phaseLabel = labelFor(p.kind);
        const isWaitingKind = p.status === "waiting" || p.status === "needs_input";
        const kind: NotifKind = isWaitingKind ? "waiting" : "failed";
        const title = p.status === "needs_input"
          ? `${phaseLabel} needs your input`
          : p.status === "waiting"
            ? `${phaseLabel} ready for review`
            : `${phaseLabel} failed`;
        const body = p.status === "needs_input"
          ? `“${task.title}” has a question for you.`
          : p.status === "waiting"
            ? `“${task.title}” is waiting for your approval.`
            : `“${task.title}” stopped during ${phaseLabel.toLowerCase()}.`;
        seeded.push({
          id: `${kind}:${task.id}:${p.id}`,
          kind,
          taskId: task.id,
          phaseId: p.id,
          title,
          body,
          ts: now,
        });
      }
    }
    if (seeded.length === 0) return;
    // Merge with whatever transitions may have arrived in the meantime.
    const existingIds = new Set(items.map((it) => it.id));
    const merged = [...items, ...seeded.filter((s) => !existingIds.has(s.id))];
    setItems(sortItems(merged));
  } catch {
    // Best-effort — first refresh after will catch up.
  }
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

/* ----------------------- Mount hook ------------------------ */

let mounted = false;

/**
 * Mount once at the app shell. Subscribes to detected transitions and
 * pushes them into the inbox (gated by the user's `inapp_notif_*`
 * prefs), seeds the inbox from current backend state on first mount,
 * and runs an auto-dismiss pass whenever runs/sources refresh.
 */
export function useNotificationInbox(): void {
  useEffect(() => {
    if (mounted) return;
    mounted = true;

    let unsubTransitions: (() => void) | null = null;
    let unlistenRunUpdated: UnlistenFn | null = null;
    let prefsHandler: (() => void) | null = null;
    let sourcesHandler: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      // Pre-load prefs so the first transition isn't lost to a race.
      let prefs = await loadInAppNotifPrefs();
      prefsHandler = () => {
        void loadInAppNotifPrefs().then((p) => { prefs = p; });
      };
      window.addEventListener("conveyer:inapp-notif-prefs-changed", prefsHandler);

      unsubTransitions = subscribeNotifTransitions((t: NotifTransition) => {
        if (!prefs.enabled) return;
        if (!prefs[t.kind]) return;
        pushItem({
          id: makeItemId(t),
          kind: t.kind,
          taskId: t.taskId,
          phaseId: t.phaseId,
          title: t.title,
          body: t.body,
          ts: t.ts,
        });
      });

      // Run an initial seed so the bell reflects currently-active
      // waiting/failed phases at launch.
      await seedFromCurrentState();

      sourcesHandler = () => { void runAutoDismissPass(); };
      window.addEventListener("conveyer:sources-refreshed", sourcesHandler);

      unlistenRunUpdated = await listen("run_updated", () => {
        void runAutoDismissPass();
      });

      if (cancelled) {
        unsubTransitions?.();
        if (prefsHandler) window.removeEventListener("conveyer:inapp-notif-prefs-changed", prefsHandler);
        if (sourcesHandler) window.removeEventListener("conveyer:sources-refreshed", sourcesHandler);
        unlistenRunUpdated?.();
      }
    })();

    return () => {
      cancelled = true;
      mounted = false;
      unsubTransitions?.();
      if (prefsHandler) window.removeEventListener("conveyer:inapp-notif-prefs-changed", prefsHandler);
      if (sourcesHandler) window.removeEventListener("conveyer:sources-refreshed", sourcesHandler);
      if (unlistenRunUpdated) unlistenRunUpdated();
    };
  }, []);
}
